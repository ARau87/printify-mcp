import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, TOOLS_BY_TOOLSET } from '../../src/tools/index.js';
import { apiErrorBody, notFoundBody } from '../fixtures/errors.js';
import { PRODUCT, product } from '../fixtures/products.js';
import { SHOP } from '../fixtures/shops.js';
import { upload } from '../fixtures/uploads.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { inTurn, json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const TOOL = 'create_product_from_image';
const SHOP_ID = SHOP.id;
const VARIANTS_PATH = '/v1/catalog/blueprints/6/print_providers/99/variants.json';
const UPLOAD_PATH = '/v1/uploads/images.json';
const PRODUCTS_PATH = `/v1/shops/${String(SHOP_ID)}/products.json`;
const ART_URL = 'https://example.com/art/sunset.png';
/** 4400 × 5500: wide enough for every print area below at scale 1. */
const ART = upload({ id: 'art-1', file_name: 'sunset.png', width: 4400, height: 5500 });

function tee(id: number, color: string, size: string, frontWidth = 4000) {
  return {
    id,
    title: `${color} / ${size}`,
    options: { color, size },
    placeholders: [
      { position: 'front', decoration_method: 'dtg', width: frontWidth, height: 5000 },
      { position: 'back', decoration_method: 'dtg', width: 4000, height: 5000 },
    ],
  };
}

/** 2XL has a wider front print area, so it needs a print area of its own. */
const TEES = {
  id: 99,
  title: 'Monster Digital',
  variants: [
    tee(101, 'Black', 'S'),
    tee(102, 'Black', 'M'),
    tee(103, 'Black', '2XL', 4800),
    tee(104, 'White', 'S'),
    tee(105, 'Red', 'M'),
  ],
};

const ROUTES = {
  [`GET ${VARIANTS_PATH}`]: TEES,
  [`POST ${UPLOAD_PATH}`]: ART,
  [`POST ${PRODUCTS_PATH}`]: PRODUCT,
};

const BASE = {
  shop_id: SHOP_ID,
  blueprint_id: 6,
  print_provider_id: 99,
  title: 'Sunset tee',
  description: '<p>Warm.</p>',
};
const FRONT = { position: 'front', image: { url: ART_URL } };
/** One variant, Red M, one design and one price: the smallest valid call. */
const RED_FRONT = { ...BASE, designs: [FRONT], variants: { colors: ['Red'] }, price: 2000 };
const UPLOADED = [{ upload_id: 'art-1', file_name: 'sunset.png', positions: ['front'] }];

describe('create_product_from_image', () => {
  it('uploads, then creates the product with one print area per placeholder size', async () => {
    const { call, api } = await createTestServer({ routes: ROUTES });
    const data = expectToolData(
      await call(TOOL, {
        ...BASE,
        designs: [FRONT],
        variants: { colors: ['black', 'WHITE'], sizes: ['s', 'M', '2xl'] },
        price: { default: 2499, by_size: { '2XL': 2799 } },
      }),
    );
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${VARIANTS_PATH}`,
      `POST ${UPLOAD_PATH}`,
      `POST ${PRODUCTS_PATH}`,
    ]);
    expect(api.expectRequest('POST', UPLOAD_PATH).body).toEqual({
      file_name: 'sunset.png',
      url: ART_URL,
    });
    expect(api.expectRequest('POST', PRODUCTS_PATH).body).toEqual({
      title: 'Sunset tee',
      description: '<p>Warm.</p>',
      blueprint_id: 6,
      print_provider_id: 99,
      variants: [
        { id: 101, price: 2499, is_enabled: true },
        { id: 102, price: 2499, is_enabled: true },
        { id: 103, price: 2799, is_enabled: true },
        { id: 104, price: 2499, is_enabled: true },
      ],
      print_areas: [
        {
          variant_ids: [101, 102, 104],
          placeholders: [
            { position: 'front', images: [{ id: 'art-1', x: 0.5, y: 0.5, scale: 1, angle: 0 }] },
          ],
        },
        {
          variant_ids: [103],
          placeholders: [
            {
              position: 'front',
              images: [{ id: 'art-1', x: 0.5, y: 0.5, scale: 0.8333, angle: 0 }],
            },
          ],
        },
      ],
    });
    expect(data).toEqual({
      product_id: PRODUCT.id,
      shop_id: SHOP_ID,
      title: PRODUCT.title,
      enabled_variants: 4,
      print_area_groups: 2,
      images: [
        {
          upload_id: 'art-1',
          file_name: 'sunset.png',
          width: 4400,
          height: 5500,
          positions: ['front'],
          reused: false,
        },
      ],
      mockups: [
        { src: 'https://images.printify.com/mockup/1.png', position: 'front', is_default: true },
        { src: 'https://images.printify.com/mockup/2.png', position: 'back', is_default: false },
      ],
      mockup_count: 3,
      next_step: expect.stringContaining('unpublished draft') as unknown,
    });
  });

  it('uploads an image used on two positions once', async () => {
    const { call, api } = await createTestServer({ routes: ROUTES });
    const back = {
      position: 'back',
      image: { url: ART_URL },
      placement: { mode: 'width', width_pct: 50, align: 'top' },
    };
    const data = expectToolData(await call(TOOL, { ...RED_FRONT, designs: [FRONT, back] }));
    api.expectRequest('POST', UPLOAD_PATH);
    expect(api.expectRequest('POST', PRODUCTS_PATH).body).toMatchObject({
      print_areas: [
        {
          variant_ids: [105],
          placeholders: [
            { position: 'front', images: [{ id: 'art-1', x: 0.5, y: 0.5, scale: 1, angle: 0 }] },
            // Half the width, so half the height: 0.5 × 0.8 × 1.25 = 0.5, centred at 0.25.
            { position: 'back', images: [{ id: 'art-1', x: 0.5, y: 0.25, scale: 0.5, angle: 0 }] },
          ],
        },
      ],
    });
    expect(data['images']).toEqual([
      {
        upload_id: 'art-1',
        file_name: 'sunset.png',
        width: 4400,
        height: 5500,
        positions: ['front', 'back'],
        reused: false,
      },
    ]);
  });

  it('reads the size of an upload_id instead of uploading', async () => {
    const { call, api } = await createTestServer({
      routes: {
        [`GET ${VARIANTS_PATH}`]: TEES,
        'GET /v1/uploads/art-1.json': ART,
        [`POST ${PRODUCTS_PATH}`]: PRODUCT,
      },
    });
    const data = expectToolData(
      await call(TOOL, {
        ...RED_FRONT,
        designs: [{ position: 'front', image: { upload_id: 'art-1' } }],
      }),
    );
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${VARIANTS_PATH}`,
      'GET /v1/uploads/art-1.json',
      `POST ${PRODUCTS_PATH}`,
    ]);
    expect(data['images']).toEqual([
      {
        upload_id: 'art-1',
        file_name: 'sunset.png',
        width: 4400,
        height: 5500,
        positions: ['front'],
        reused: true,
      },
    ]);
  });

  it('reports the uploads when Printify rejects the create', async () => {
    const body = apiErrorBody({
      code: 8203,
      message: 'Validation failed.',
      reason: 'Image has low quality',
    });
    const { call } = await createTestServer({
      routes: { ...ROUTES, [`POST ${PRODUCTS_PATH}`]: json(body, 400) },
    });
    expectToolError(await call(TOOL, RED_FRONT), {
      kind: 'http',
      status: 400,
      code: 8203,
      reason: 'Image has low quality',
      uploaded: UPLOADED,
    });
  });

  it('warns about an image narrower than it is printed, and still creates the product', async () => {
    const small = upload({ id: 'art-1', file_name: 'sunset.png', width: 1000, height: 1250 });
    const { call, api } = await createTestServer({
      routes: { ...ROUTES, [`POST ${UPLOAD_PATH}`]: small },
    });
    const data = expectToolData(await call(TOOL, RED_FRONT));
    expect(data['warnings']).toEqual([
      'sunset.png is 1000 px wide but needs 4000 px on front (25%) for 1 variant',
    ]);
    api.expectRequest('POST', PRODUCTS_PATH);
  });

  it('refuses a too-small image with strict, after the upload, and reports the upload', async () => {
    const small = upload({ id: 'art-1', file_name: 'sunset.png', width: 1000, height: 1250 });
    const { call, api } = await createTestServer({
      routes: { ...ROUTES, [`POST ${UPLOAD_PATH}`]: small },
    });
    const error = expectToolError(await call(TOOL, { ...RED_FRONT, strict: true }), {
      kind: 'tool',
      uploaded: UPLOADED,
    });
    expect(error.message).toContain(
      'sunset.png is 1000 px wide but needs 4000 px on front (25%) for 1 variant',
    );
    api.expectRequest('POST', UPLOAD_PATH);
    expect(api.requests.filter((request) => request.path === PRODUCTS_PATH)).toHaveLength(0);
  });

  it('checks the colors before uploading anything', async () => {
    const { call, api } = await createTestServer({ routes: ROUTES });
    const uploads = () => api.requests.filter((request) => request.path === UPLOAD_PATH).length;
    // A valid call first, so the count below is known to move when an upload happens.
    expectToolData(await call(TOOL, RED_FRONT));
    expect(uploads()).toBe(1);
    const error = expectToolError(
      await call(TOOL, { ...RED_FRONT, variants: { colors: ['Neon'] } }),
      { kind: 'tool' },
    );
    expect(error.message).toBe(
      'Unknown colors: "Neon". The colors in stock are: Black, White, Red.',
    );
    expect(error).not.toHaveProperty('uploaded');
    expect(uploads()).toBe(1);
  });

  it('refuses an image with two sources, naming the three it takes', async () => {
    const { call, api } = await createTestServer({ routes: ROUTES });
    const error = expectToolError(
      await call(TOOL, {
        ...RED_FRONT,
        designs: [{ position: 'front', image: { upload_id: 'art-1', url: ART_URL } }],
      }),
      { kind: 'tool' },
    );
    expect(error.message).toBe(
      'designs[0].image needs exactly one of upload_id, url or file_path; got upload_id and url.',
    );
    expect(api.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('passes on a 404 for an unknown upload_id, before uploading anything', async () => {
    const { call, api } = await createTestServer({
      routes: {
        ...ROUTES,
        'GET /v1/uploads/nope.json': json(notFoundBody(), 404),
      },
    });
    const error = expectToolError(
      await call(TOOL, {
        ...RED_FRONT,
        designs: [FRONT, { position: 'back', image: { upload_id: 'nope' } }],
      }),
      { kind: 'http', status: 404 },
    );
    expect(error).not.toHaveProperty('uploaded');
    expect(api.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('refuses contain when Printify reports no pixel size, and reports the upload', async () => {
    const sizeless = { ...ART, width: null, height: null };
    const { call } = await createTestServer({
      routes: { ...ROUTES, [`POST ${UPLOAD_PATH}`]: sizeless },
    });
    const error = expectToolError(await call(TOOL, RED_FRONT), {
      kind: 'tool',
      message:
        'Printify did not report the pixel size of sunset.png, so placement mode "contain" ' +
        'cannot be worked out.',
      uploaded: UPLOADED,
    });
    expect(error.hint).toContain('mode: "custom"');
  });

  it('places custom without a pixel size, and warns that it could not check it', async () => {
    const sizeless = { ...ART, width: null, height: null };
    const { call } = await createTestServer({
      routes: { ...ROUTES, [`POST ${UPLOAD_PATH}`]: sizeless },
    });
    const custom = { ...FRONT, placement: { mode: 'custom', x: 0.5, y: 0.4, scale: 0.9 } };
    const data = expectToolData(await call(TOOL, { ...RED_FRONT, designs: [custom] }));
    expect(data['warnings']).toEqual([
      'resolution of sunset.png could not be checked: Printify did not report its size',
    ]);
  });

  it('lists only the uploads that happened when a later upload fails', async () => {
    const rejected = apiErrorBody({
      code: 10100,
      message: 'Validation failed.',
      reason: 'Bad image',
    });
    const { call } = await createTestServer({
      routes: { ...ROUTES, [`POST ${UPLOAD_PATH}`]: inTurn(ART, json(rejected, 400)) },
    });
    const back = { position: 'back', image: { url: 'https://example.com/art/moon.png' } };
    expectToolError(await call(TOOL, { ...RED_FRONT, designs: [FRONT, back] }), {
      kind: 'http',
      status: 400,
      uploaded: UPLOADED,
    });
  });

  it('returns at most 6 mockups and the full count', async () => {
    const images = Array.from({ length: 8 }, (_item, index) => ({
      src: `https://images.printify.com/mockup/m${String(index)}.png`,
      variant_ids: [105],
      position: `camera-${String(index)}`,
      is_default: index === 7,
    }));
    const { call } = await createTestServer({
      routes: { ...ROUTES, [`POST ${PRODUCTS_PATH}`]: product({ images }) },
    });
    const data = expectToolData(await call(TOOL, RED_FRONT));
    expect(data['mockups']).toHaveLength(6);
    expect(data['mockup_count']).toBe(8);
    expect(data).not.toHaveProperty('warnings');
  });

  it('is a write tool, filed under workflows and registered by default', async () => {
    const { mcp } = await createTestServer();
    const { tools } = await mcp.listTools();
    expect(tools.find((tool) => tool.name === TOOL)?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(TOOLS_BY_TOOLSET.workflows.map((tool) => tool.name)).toEqual([TOOL]);
  });

  it('does not name publish_product in next_step, because no such tool exists yet', async () => {
    // The publishing toolset (#12) makes this fail on purpose: next_step should then name it.
    expect(ALL_TOOLS.map((tool) => tool.name)).not.toContain('publish_product');
    const { call } = await createTestServer({ routes: ROUTES });
    const data = expectToolData(await call(TOOL, RED_FRONT));
    expect(data['next_step']).not.toContain('publish_product');
  });
});
