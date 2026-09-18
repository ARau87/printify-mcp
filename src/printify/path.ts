/** A Printify API path such as `/v1/shops/12/products.json`. Only `apiPath` makes one. */
export type ApiPath = string & { readonly __brand: 'ApiPath' };

/**
 * Builds an `ApiPath` from a template, URL-encoding every value, so an id that came from the model
 * cannot change the route: apiPath`/v1/shops/${shopId}/products/${productId}.json`.
 */
export function apiPath(
  strings: TemplateStringsArray,
  ...values: readonly (string | number)[]
): ApiPath {
  const head = strings[0] ?? '';
  if (!head.startsWith('/v1/') && !head.startsWith('/v2/')) {
    throw new TypeError(`API paths must start with /v1/ or /v2/, got "${head}"`);
  }
  let path = head;
  values.forEach((value, index) => {
    const text = String(value);
    // encodeURIComponent leaves dots alone, and the URL parser would resolve "." and ".." segments.
    if (text === '' || text === '.' || text === '..') {
      throw new TypeError('API path values must not be empty, "." or ".."');
    }
    path += encodeURIComponent(text) + (strings[index + 1] ?? '');
  });
  return path as ApiPath;
}
