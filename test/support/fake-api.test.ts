import { describe, expect, it } from 'vitest';
import { SHOPS } from '../fixtures/shops.js';
import { createFakeApi, empty, inTurn, json } from './fake-api.js';

const BASE = 'https://api.printify.com';

describe('createFakeApi: serving routes', () => {
  it('serves a bare value as a 200 JSON body', async () => {
    const api = createFakeApi({ 'GET /v1/shops.json': SHOPS });
    const response = await api.fetch(`${BASE}/v1/shops.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SHOPS);
  });

  it('serves a Response as it is, keeping its status', async () => {
    const api = createFakeApi({ 'GET /v1/x.json': json({ error: 'nope' }, 404) });
    const response = await api.fetch(`${BASE}/v1/x.json`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'nope' });
  });

  it('serves empty() as a 204 with no body', async () => {
    const api = createFakeApi({ 'DELETE /v1/x.json': empty() });
    const response = await api.fetch(`${BASE}/v1/x.json`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('answers the same route twice, because the Response is cloned', async () => {
    const api = createFakeApi({ 'GET /v1/shops.json': json(SHOPS) });
    expect(await (await api.fetch(`${BASE}/v1/shops.json`)).json()).toEqual(SHOPS);
    expect(await (await api.fetch(`${BASE}/v1/shops.json`)).json()).toEqual(SHOPS);
  });

  it('answers in turn and repeats the last reply', async () => {
    const api = createFakeApi({ 'GET /v1/x.json': inTurn(json({ n: 1 }), json({ n: 2 })) });
    const seen: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      seen.push(await (await api.fetch(`${BASE}/v1/x.json`)).json());
    }
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 2 }]);
  });

  it('passes the query to a responder without matching on it', async () => {
    const api = createFakeApi({ 'GET /v1/x.json': (request) => ({ page: request.query.page }) });
    const response = await api.fetch(`${BASE}/v1/x.json?page=3&limit=10`);
    expect(await response.json()).toEqual({ page: '3' });
    expect(api.requests[0]?.query).toEqual({ page: '3', limit: '10' });
  });

  it('records the method, path and parsed body of a request', async () => {
    const api = createFakeApi({ 'POST /v1/x.json': json({ ok: true }) });
    await api.fetch(`${BASE}/v1/x.json`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Tee' }),
    });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/x.json',
      body: { title: 'Tee' },
    });
  });
});

describe('createFakeApi: route keys', () => {
  it.each([
    ['GET/v1/x.json', /Invalid route key/],
    ['PATCH /v1/x.json', /Invalid route key/],
    ['GET v1/x.json', /must start with/],
    ['GET /v1/x.json extra', /Invalid route key/],
  ])('rejects the malformed key %s', (key, message) => {
    expect(() => createFakeApi({ [key]: 1 })).toThrow(message);
  });
});

describe('createFakeApi: unmatched requests', () => {
  it('answers 418 with a message naming the declared routes', async () => {
    const api = createFakeApi({ 'GET /v1/shops.json': SHOPS });
    const response = await api.fetch(`${BASE}/v1/nope.json`);
    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({
      error:
        'printify-mcp test harness: no route for GET /v1/nope.json. ' +
        'Declared routes: GET /v1/shops.json',
    });
  });

  it('says "(none)" when no route was declared', async () => {
    const api = createFakeApi();
    const response = await api.fetch(`${BASE}/v1/nope.json`);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Declared routes: (none)');
  });

  it('assertNoUnmatched throws and names every unmatched request', async () => {
    const api = createFakeApi();
    await api.fetch(`${BASE}/v1/a.json`);
    await api.fetch(`${BASE}/v1/b.json`, { method: 'POST' });
    expect(() => {
      api.assertNoUnmatched();
    }).toThrow(/2 request\(s\) that matched no route: GET \/v1\/a.json, POST \/v1\/b.json/);
  });

  it('assertNoUnmatched passes once takeUnmatched has cleared them', async () => {
    const api = createFakeApi();
    await api.fetch(`${BASE}/v1/a.json`);
    expect(api.takeUnmatched()).toHaveLength(1);
    expect(api.unmatched).toHaveLength(0);
    expect(() => {
      api.assertNoUnmatched();
    }).not.toThrow();
  });
});

describe('createFakeApi: expectRequest', () => {
  it('returns the one matching request and matches its body', async () => {
    const api = createFakeApi({ 'POST /v1/x.json': json({ ok: true }) });
    await api.fetch(`${BASE}/v1/x.json`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Tee', extra: 1 }),
    });
    expect(api.expectRequest('POST', '/v1/x.json', { title: 'Tee' }).path).toBe('/v1/x.json');
  });

  it('lists the recorded requests when nothing matched', async () => {
    const api = createFakeApi({ 'POST /v1/x.json': json({ ok: true }) });
    await api.fetch(`${BASE}/v1/x.json`, { method: 'POST' });
    expect(() => api.expectRequest('GET', '/v1/x.json')).toThrow(
      /expected exactly one "GET \/v1\/x.json", got 0\. Recorded: POST \/v1\/x.json/,
    );
  });

  it('fails when the same route was called twice', async () => {
    const api = createFakeApi({ 'GET /v1/x.json': json({ ok: true }) });
    await api.fetch(`${BASE}/v1/x.json`);
    await api.fetch(`${BASE}/v1/x.json`);
    expect(() => api.expectRequest('GET', '/v1/x.json')).toThrow(/got 2/);
  });
});
