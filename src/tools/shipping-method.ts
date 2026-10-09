import { SHIPPING_METHODS, type ShippingMethod } from '../printify/catalog.js';

/** The names `create_order` takes, shared with the catalog's shipping tools. */
export const ORDER_SHIPPING_METHODS = SHIPPING_METHODS;
export type { ShippingMethod };

export type ShippingMethodCode = 1 | 2 | 3 | 4;

// The order endpoints take a code: 1 standard, 2 priority (once called express), 3 Printify
// Express (the docs' transitional printify_express, final name express), 4 economy.
const CODES: Readonly<Record<ShippingMethod, ShippingMethodCode>> = {
  standard: 1,
  priority: 2,
  express: 3,
  economy: 4,
};

const NAMES: ReadonlyMap<number, ShippingMethod> = new Map(
  ORDER_SHIPPING_METHODS.map((method) => [CODES[method], method]),
);

/** One method of a shipping quote: its name, the code `create_order` sends, the cost in cents. */
export interface QuoteRow {
  method: ShippingMethod;
  code: ShippingMethodCode;
  cost: number;
}

export interface ShippingQuote {
  methods: QuoteRow[];
  /** Keys of the quote no rule consumed, so a renamed method is visible rather than lost. */
  other?: Record<string, number>;
}

export function shippingMethodCode(method: ShippingMethod): ShippingMethodCode {
  return CODES[method];
}

/** The name for a code, the code as text when it is not one of the four, undefined for none. */
export function shippingMethodName(code: number | undefined): string | undefined {
  if (code === undefined) return undefined;
  return NAMES.get(code) ?? String(code);
}

/**
 * Translates `shipping.json`'s flat answer into rows named like `create_order`'s input. Printify
 * is renaming its keys: the old set is standard/express/economy, the current one adds priority
 * (same cost as express) and printify_express, and the final one is standard/priority/express/
 * economy with express meaning Printify Express. Each rule consumes the key it reads.
 */
export function parseShippingQuote(raw: Readonly<Record<string, number>>): ShippingQuote {
  const rest = new Map(Object.entries(raw));
  const take = (key: string): number | undefined => {
    const value = rest.get(key);
    rest.delete(key);
    return value;
  };
  const standard = take('standard');
  const priority = take('priority');
  const oldExpress = take('express');
  const printifyExpress = take('printify_express');
  const economy = take('economy');

  const costs: Partial<Record<ShippingMethod, number>> = {
    standard,
    priority: priority ?? oldExpress,
    // With priority present, express is the final spelling of Printify Express.
    express: printifyExpress ?? (priority === undefined ? undefined : oldExpress),
    economy,
  };
  const methods: QuoteRow[] = [];
  for (const method of ORDER_SHIPPING_METHODS) {
    const cost = costs[method];
    if (cost !== undefined) methods.push({ method, code: CODES[method], cost });
  }
  return rest.size === 0 ? { methods } : { methods, other: Object.fromEntries(rest) };
}
