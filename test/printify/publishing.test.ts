import { describe, expect, it } from 'vitest';
import { createPrintifyClient, type PrintifyClient } from '../../src/printify/client.js';
import {
  publishProduct,
  setProductUnpublished,
  setPublishingFailed,
  setPublishingSucceeded,
  type PublishFlags,
} from '../../src/printify/publishing.js';
import { Secret } from '../../src/secret.js';
import { PRODUCT } from '../fixtures/products.js';
import { SHOP } from '../fixtures/shops.js';
import { createFakeApi, json, text, type FakeApi, type Routes } from '../support/fake-api.js';

const TOKEN = 'Tok-publishing-7G8h9I0j';
const SHOP_ID = SHOP.id;
const BASE = `/v1/shops/${String(SHOP_ID)}/products/${PRODUCT.id}`;
const PUBLISH_PATH = `${BASE}/publish.json`;
const SUCCEEDED_PATH = `${BASE}/publishing_succeeded.json`;
const FAILED_PATH = `${BASE}/publishing_failed.json`;
const UNPUBLISH_PATH = `${BASE}/unpublish.json`;

const ALL_TRUE: PublishFlags = {
  title: true,
  description: true,
  images: true,
  variants: true,
  tags: true,
  keyFeatures: true,
  shipping_template: true,
};

function testClient(routes: Routes = {}): { client: PrintifyClient; api: FakeApi } {
  const api = createFakeApi(routes);
  const client = createPrintifyClient({
    token: new Secret(TOKEN),
    baseUrl: 'https://api.printify.com',
    fetch: api.fetch,
  });
  return { client, api };
}

/** A signal that has not aborted. */
function live(): AbortSignal {
  return new AbortController().signal;
}

describe('publishProduct', () => {
  it('posts the flags as given, keyFeatures spelled the way Printify wants it', async () => {
    const { client, api } = testClient({ [`POST ${PUBLISH_PATH}`]: json({}) });
    const flags = { ...ALL_TRUE, tags: false };
    await expect(publishProduct(client, SHOP_ID, PRODUCT.id, flags, live())).resolves.toBe(
      undefined,
    );
    expect(api.expectRequest('POST', PUBLISH_PATH).body).toEqual(flags);
  });

  it('URL-encodes the product id', async () => {
    const path = `/v1/shops/${String(SHOP_ID)}/products/a%20b/publish.json`;
    const { client, api } = testClient({ [`POST ${path}`]: json({}) });
    await publishProduct(client, SHOP_ID, 'a b', ALL_TRUE, live());
    api.expectRequest('POST', path);
  });
});

describe('setPublishingSucceeded', () => {
  it('posts the external reference as the documented object', async () => {
    const { client, api } = testClient({ [`POST ${SUCCEEDED_PATH}`]: json({}) });
    const external = { id: '5941187eb8e7e37b3f0e62e5', handle: 'https://example.com/p/tee' };
    await expect(
      setPublishingSucceeded(client, SHOP_ID, PRODUCT.id, external, live()),
    ).resolves.toBeUndefined();
    expect(api.expectRequest('POST', SUCCEEDED_PATH).body).toEqual({ external });
  });
});

describe('setPublishingFailed', () => {
  it('posts the reason', async () => {
    const { client, api } = testClient({ [`POST ${FAILED_PATH}`]: json({}) });
    await expect(
      setPublishingFailed(client, SHOP_ID, PRODUCT.id, 'Request timed out', live()),
    ).resolves.toBeUndefined();
    expect(api.expectRequest('POST', FAILED_PATH).body).toEqual({ reason: 'Request timed out' });
  });
});

describe('setProductUnpublished', () => {
  it('posts without a body', async () => {
    const { client, api } = testClient({ [`POST ${UNPUBLISH_PATH}`]: json({}) });
    await expect(
      setProductUnpublished(client, SHOP_ID, PRODUCT.id, live()),
    ).resolves.toBeUndefined();
    expect(api.expectRequest('POST', UNPUBLISH_PATH).body).toBeUndefined();
  });

  it('accepts a wholly empty answer, like archiveUpload', async () => {
    const { client } = testClient({ [`POST ${UNPUBLISH_PATH}`]: text('', 200) });
    await expect(setProductUnpublished(client, SHOP_ID, PRODUCT.id, live())).resolves.toBe(
      undefined,
    );
  });
});
