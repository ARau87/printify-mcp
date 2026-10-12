# printify-mcp

An MCP server for the [Printify](https://printify.com) print-on-demand API. It speaks the Model
Context Protocol over stdio, is configured with environment variables, and gives an AI assistant
such as Claude the tools to browse the catalog, upload artwork, create and update products, and
publish them to your store.

## Why this one

- One tool per Printify endpoint, grouped into toolsets you can switch on and off.
- Workflow tools for the hard parts: `search_blueprints` searches the whole catalog by text,
  `get_print_areas` tells you where artwork can go and how large it must be, and
  `create_product_from_image` uploads, places, prices and creates a product in one call.
- Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), so a
  client can show what a call will do before it runs.
- Tools that spend money or cannot be undone are not registered unless you opt in.
- Compact responses, a catalog cache, and rate limiting that waits or refuses before Printify
  answers 429.

## Quick start

1. **Create a Personal Access Token** in Printify under **My Profile → Connections** and pick its
   scopes. For everything this release offers, select `shops.read`, `catalog.read`,
   `print_providers.read`, `uploads.read`, `uploads.write`, `products.read`, `products.write`,
   `orders.read` and `orders.write`. For a setup that cannot change anything, leave out
   `uploads.write` and `products.write`; `orders.write` stays, because the shipping quote in
   `calculate_shipping` is a write call to Printify even though it creates nothing. The mapping per
   toolset is under [Token scopes by toolset](#token-scopes-by-toolset). Copy the token now:
   Printify shows it once, and it expires after one year.
2. **Add the server to your client.** With Claude Code:

   ```bash
   claude mcp add printify -e PRINTIFY_API_TOKEN=your-token -- npx -y printify-mcp
   ```

   Other clients are under [Configure your client](#configure-your-client).

3. **Ask for something.** "List my Printify shops." If the account has one shop, every
   shop-scoped tool uses it. Otherwise set `PRINTIFY_SHOP_ID`, or name the shop in the prompt.

## Configure your client

Every client runs the same command, `npx -y printify-mcp`, with the token in the server's
environment. Node.js 22 or newer must be installed.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "printify": {
      "command": "npx",
      "args": ["-y", "printify-mcp"],
      "env": {
        "PRINTIFY_API_TOKEN": "your-token"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add printify -e PRINTIFY_API_TOKEN=your-token -- npx -y printify-mcp
```

Add `-s user` after `add` to make the server available in every project rather than only the
current one. Other variables go in further `-e` flags, for example `-e PRINTIFY_SHOP_ID=12345`.

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "printify": {
      "command": "npx",
      "args": ["-y", "printify-mcp"],
      "env": {
        "PRINTIFY_API_TOKEN": "your-token"
      }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`. The `inputs` entry makes VS Code prompt for the token and store it itself, so
it is not written into a file you might commit:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "printify-token",
      "description": "Printify Personal Access Token",
      "password": true
    }
  ],
  "servers": {
    "printify": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "printify-mcp"],
      "env": {
        "PRINTIFY_API_TOKEN": "${input:printify-token}"
      }
    }
  }
}
```

The server reads nothing but its environment variables. It never writes configuration files.

## Safety model

Out of the box the server can read anything the token allows, and can upload images and create,
update and publish products. It cannot place orders, delete or archive anything, disconnect a
shop, or read files from your disk. Each of those is behind a setting you turn on deliberately.

### Toolsets

`PRINTIFY_TOOLSETS` is a comma-separated list of the toolsets to offer; unset, all of them are on.
A setup that can browse the catalog and manage products but never upload would use
`PRINTIFY_TOOLSETS=shops,catalog,products`. The toolsets with tools in this release are `shops`,
`catalog`, `uploads`, `products`, `publishing`, `orders` and `workflows`. The names
`personalization`, `support` and `webhooks` are reserved for later releases and have no tools yet.

### Orders: `PRINTIFY_ENABLE_ORDERS=true`

Registers the tools that place orders or change one: `create_order`, `create_express_order`,
`send_order_to_production` and `cancel_order`. The read-only order tools (`list_orders`,
`get_order` and `calculate_shipping`) are on without it. Read this before you ever set it:

> **Orders cost money.** By default Printify approves an order and sends it to production
> 24 hours after it is placed, and charges your payment method then. You do not have to call
> "send to production" for that to happen. Before enabling order tools, set order approval to
> **Manual** in Printify under **Store settings → Order settings**, or make sure you want
> automatic approval. See Printify's help centre on
> [order approval settings](https://help.printify.com/hc/en-us/articles/4483625253265-How-do-I-set-up-store-details-and-order-approval-settings)
> and [when Printify charges](https://help.printify.com/hc/en-us/articles/4483630446865-When-does-Printify-charge-for-an-order).

### Destructive tools: `PRINTIFY_ENABLE_DESTRUCTIVE=true`

Registers `disconnect_shop`, `archive_upload` and `delete_product`. None of them can be undone:
Printify has no reconnect, unarchive or undelete endpoint. The tool reference below marks every
gated tool in its **Needs** column.

### Local files: `PRINTIFY_UPLOAD_DIRS`

`upload_image` and `create_product_from_image` accept a `file_path` only inside the directories
listed here. Unset, local file reads are off and uploads use a public URL or base64. Entries are
absolute paths separated by `:` on macOS and Linux and by `;` on Windows; `~` is expanded. Example:
`PRINTIFY_UPLOAD_DIRS=~/designs`.

### When something is off

When a flag or toolset is off, the server tells the assistant through its MCP instructions which
tools were not registered and which variable enables them, and logs one line per reason to stderr
at startup. So when the assistant says it has no delete tool, that is by design, and the fix is in
your client configuration.

## Environment variables

| Variable                      | Required | Default                    | Notes                                                                                        |
| ----------------------------- | -------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `PRINTIFY_API_TOKEN`          | yes      |                            | Personal Access Token. Visible ASCII only; a token with a line break or space is rejected.   |
| `PRINTIFY_SHOP_ID`            | no       | the account's only shop    | Numeric id. Shop-scoped tools use it when a call gives no `shop_id`.                         |
| `PRINTIFY_TOOLSETS`           | no       | all                        | Comma-separated. Unknown names are rejected with a suggestion.                               |
| `PRINTIFY_ENABLE_ORDERS`      | no       | `false`                    | `true` or `false` only.                                                                      |
| `PRINTIFY_ENABLE_DESTRUCTIVE` | no       | `false`                    | `true` or `false` only.                                                                      |
| `PRINTIFY_UPLOAD_DIRS`        | no       | none (local files off)     | Absolute, existing directories; `~` allowed; separated by `:` (`;` on Windows).              |
| `PRINTIFY_API_BASE_URL`       | no       | `https://api.printify.com` | For proxies. Must be `https` (`http` only for localhost), no credentials, no `/v1` or `/v2`. |

An empty value counts as unset. An unknown `PRINTIFY_*` variable produces a warning at startup
with a suggestion for the name you meant. Invalid configuration stops startup, with every problem
listed. `printify-mcp --help` prints the same variables.

<!-- The variables and the scopes below are kept by hand. src/config.ts and the --help text in
src/cli.ts are the other two places that list the variables. -->

## Token scopes by toolset

Printify does not publish which scope each endpoint needs. This is the mapping this project has
worked out from the endpoints each toolset calls; a 403 from the server names the scope it
believes is missing.

| Toolset      | Scopes                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `shops`      | `shops.read`                                                                                                                               |
| `catalog`    | `catalog.read`, `print_providers.read`                                                                                                     |
| `uploads`    | `uploads.read`; `uploads.write` for `upload_image` and `archive_upload`                                                                    |
| `products`   | `products.read`; `products.write` for `create_product`, `update_product`, `delete_product`                                                 |
| `publishing` | `products.write`                                                                                                                           |
| `orders`     | `orders.read`; `orders.write` for `calculate_shipping`, `create_order`, `create_express_order`, `send_order_to_production`, `cancel_order` |
| `workflows`  | `catalog.read`, `uploads.write`, `products.write`                                                                                          |

`shops.read` is needed by every setup: shop-scoped tools resolve the default shop from the shop
list, and the publishing tools read it to tell connected shops from API shops. `webhooks.read` and
`webhooks.write` are not used by any tool in this release.

## Tools

Every tool the server can offer, generated from the registry by `npm run docs:tools`. **Access**
comes from the tool's annotations; **Needs** is the flag that registers it.

<!-- tools:start -->

_34 tools in 7 toolsets._

| Tool                        | Toolset    | Access      | Needs                              | Description                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ---------- | ----------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_shops`                | shops      | read-only   |                                    | Lists the shops in the Printify account with their id, title and sales channel ("disconnected" when no sales channel is connected, e.g. an API shop).                                                                                                                                                                |
| `disconnect_shop`           | shops      | destructive | `PRINTIFY_ENABLE_DESTRUCTIVE=true` | Disconnects a shop from Printify.                                                                                                                                                                                                                                                                                    |
| `search_blueprints`         | catalog    | read-only   |                                    | Searches the whole Printify catalog for blueprints (product templates such as t-shirts, hoodies or mugs) and returns their ids.                                                                                                                                                                                      |
| `get_blueprint`             | catalog    | read-only   |                                    | Gets one catalog blueprint (a product template such as a t-shirt or a mug) by id: its title, brand, model, description and tags.                                                                                                                                                                                     |
| `list_blueprint_providers`  | catalog    | read-only   |                                    | Lists the print providers that can make a blueprint, with each one's decoration methods (such as dtg or embroidery) and location.                                                                                                                                                                                    |
| `list_variants`             | catalog    | read-only   |                                    | Lists the variants (the size and color combinations) a print provider offers for a blueprint.                                                                                                                                                                                                                        |
| `get_print_areas`           | catalog    | read-only   |                                    | Summarises where artwork can go on a blueprint from one print provider and how big it must be: each print position (front, back, sleeve …) with its decoration method, its printable size in pixels and its aspect ratio, aggregated over every variant in stock, plus the colors and sizes to choose variants from. |
| `get_shipping_info`         | catalog    | read-only   |                                    | Gets a print provider's shipping costs and handling time for a blueprint.                                                                                                                                                                                                                                            |
| `list_print_providers`      | catalog    | read-only   |                                    | Lists every Printify print provider with its id, name and location.                                                                                                                                                                                                                                                  |
| `get_print_provider`        | catalog    | read-only   |                                    | Gets one print provider: its name, its address, and the blueprints it offers (id, title, brand and model).                                                                                                                                                                                                           |
| `list_shipping_methods`     | catalog    | read-only   |                                    | Lists the shipping methods a print provider offers for a blueprint: standard, priority, express or economy.                                                                                                                                                                                                          |
| `get_shipping_costs`        | catalog    | read-only   |                                    | Gets a print provider's shipping costs and handling time for a blueprint, broken down by shipping method.                                                                                                                                                                                                            |
| `upload_image`              | uploads    | writes      |                                    | Uploads an image to the Printify image library, so a product can print it.                                                                                                                                                                                                                                           |
| `list_uploads`              | uploads    | read-only   |                                    | Lists the images already in the Printify image library, with the id, file name, pixel size, byte size and type of each.                                                                                                                                                                                              |
| `get_upload`                | uploads    | read-only   |                                    | Gets one uploaded image by its id: file name, pixel size, byte size, type and preview URL.                                                                                                                                                                                                                           |
| `archive_upload`            | uploads    | destructive | `PRINTIFY_ENABLE_DESTRUCTIVE=true` | Archives an image, removing it from the Printify image library.                                                                                                                                                                                                                                                      |
| `list_products`             | products   | read-only   |                                    | Lists the products in a shop: each one's id, title, blueprint and print provider ids, whether it is visible in the sales channel, whether it is locked for publishing, how many variants it has and how many are enabled, and its sales-channel reference.                                                           |
| `get_product`               | products   | read-only   |                                    | Gets one product.                                                                                                                                                                                                                                                                                                    |
| `get_product_gpsr`          | products   | read-only   |                                    | Gets a product's General Product Safety Regulation (GPSR) information: the sections Printify derives from its safety_information, each with a title and text.                                                                                                                                                        |
| `create_product`            | products   | writes      |                                    | Creates a product from a catalog blueprint and print provider (from search_blueprints and list_blueprint_providers), with the variants to offer (ids from list_variants, prices in cents) and the artwork to print.                                                                                                  |
| `update_product`            | products   | writes      |                                    | Updates a product.                                                                                                                                                                                                                                                                                                   |
| `delete_product`            | products   | destructive | `PRINTIFY_ENABLE_DESTRUCTIVE=true` | Deletes a product from the shop.                                                                                                                                                                                                                                                                                     |
| `publish_product`           | publishing | writes      |                                    | Publishes a product to the shop's sales channel.                                                                                                                                                                                                                                                                     |
| `set_publishing_succeeded`  | publishing | writes      |                                    | Tells Printify that an API shop's integration published the product, which unlocks it and records the listing's external id and handle (its URL or path in the sales channel).                                                                                                                                       |
| `set_publishing_failed`     | publishing | writes      |                                    | Tells Printify that an API shop's integration could not publish the product, which unlocks it; the reason is shown in the Printify app.                                                                                                                                                                              |
| `set_product_unpublished`   | publishing | writes      |                                    | Tells Printify that the product's listing was removed from the sales channel, so Printify shows it as unpublished.                                                                                                                                                                                                   |
| `list_orders`               | orders     | read-only   |                                    | Lists a shop's orders, newest first, as compact rows: id, external_id, status, shipping method, totals in cents, line item count and timestamps.                                                                                                                                                                     |
| `get_order`                 | orders     | read-only   |                                    | Gets one order: its line items (product, variant, quantity, costs, status, print provider country), totals in cents, status, shipments with tracking, and reprint metadata.                                                                                                                                          |
| `calculate_shipping`        | orders     | read-only   |                                    | Quotes the shipping cost of an order before it is placed: one row per shipping method, in cents, for the given line items and address.                                                                                                                                                                               |
| `create_order`              | orders     | destructive | `PRINTIFY_ENABLE_ORDERS=true`      | Creates an order.                                                                                                                                                                                                                                                                                                    |
| `create_express_order`      | orders     | destructive | `PRINTIFY_ENABLE_ORDERS=true`      | Creates an order with Printify Express Delivery, for existing products only.                                                                                                                                                                                                                                         |
| `send_order_to_production`  | orders     | destructive | `PRINTIFY_ENABLE_ORDERS=true`      | Sends an order to production now.                                                                                                                                                                                                                                                                                    |
| `cancel_order`              | orders     | destructive | `PRINTIFY_ENABLE_ORDERS=true`      | Cancels an order that has not been paid or sent to production.                                                                                                                                                                                                                                                       |
| `create_product_from_image` | workflows  | writes      |                                    | Creates a product from artwork in one call: uploads the images, picks the variants, works out where each image sits on each print area, and creates the product as an unpublished draft.                                                                                                                             |

<!-- tools:end -->

## Example prompts

- "Find t-shirt blueprints by Bella+Canvas and show me who prints them in Europe."
- "Where can artwork go on a Bella+Canvas 3001 from the first of those providers, and how large
  does it have to be?"
- "Create a product in my shop from ~/designs/sunset.png on that blueprint and provider: every
  size in black and white, printed on the front, priced at 24.99." This needs
  `PRINTIFY_UPLOAD_DIRS=~/designs`, or a public image URL instead of the path.
- "Raise the price of every variant of product 66f1a2b3c4d5e6f7a8b9c0d1 by 2 dollars."
- "Publish product 66f1a2b3c4d5e6f7a8b9c0d1 to my Shopify store."
- "Quote the shipping for two of variant 12345 of that product to this address." Then, if you want
  the order placed: "Order it with standard shipping, order id web-1001." Placing it needs
  `PRINTIFY_ENABLE_ORDERS=true`; read the warning above first.
- "Archive the upload named old-logo.png." This needs `PRINTIFY_ENABLE_DESTRUCTIVE=true`.

## Troubleshooting

**401 Unauthorized.** The token is invalid, expired or revoked. Personal Access Tokens last one
year. Create a new one under My Profile → Connections and update the client configuration.

**403 Forbidden.** Usually a missing scope. The error names the scope the server thinks the
endpoint needs, with a "probably", because Printify does not publish the mapping. Create a new
token with that scope; a token's scopes cannot be edited afterwards.

**429, or "the limit … is used up".** Printify allows 600 requests per minute overall, 100 per
minute on catalog endpoints and 200 per 30 minutes on publishing. The server waits for short gaps
and refuses without sending when the wait would be long, so a refusal that names a retry time is
the server protecting the limit, not a Printify error. Catalog-heavy prompts reach the catalog
limit first; `search_blueprints` and the catalog cache exist to avoid that.

**"The product is locked" after publishing.** On a shop with no connected sales channel,
publishing only locks the product and fires an event for your own integration. Call
`set_publishing_succeeded` or `set_publishing_failed` to unlock it. On a shop connected to
Shopify, Etsy or another channel, wait for the channel; `get_product` shows `is_locked`.

**Error 8203, low resolution.** The artwork is too small for the print area at that scale. Ask for
`get_print_areas` to see the size each position needs, then use a larger image or a smaller
`scale`.

**Large uploads.** Printify recommends uploading files over 5 MB by `url` rather than base64, and
this server refuses base64 and local files over 25 MB. Host the file somewhere public and pass the
URL.

**A tool is missing.** It is behind a flag or its toolset is off. The assistant was told which one
at startup. Set the variable in the client configuration and restart the client.

**The server does not start.** It prints every configuration problem to stderr and exits. Your
client shows that output in its MCP logs; Claude Code's `claude mcp list` reports whether the
server connected.

## Contributing

Bug reports, feature requests and documentation fixes go through the
[issue templates](https://github.com/ARau87/printify-mcp/issues/new/choose).
[CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, the test harness, how to add a
tool, and the live tests.
