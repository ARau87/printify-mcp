import { describe, expect, it } from 'vitest';
import { placeImage, resolutionWarning } from '../../src/tools/placement.js';

const PORTRAIT_AREA = { width: 4000, height: 5000 };
const PORTRAIT_ART = { width: 2000, height: 3000 };
const LANDSCAPE_ART = { width: 3000, height: 2000 };

describe('placeImage', () => {
  it('contain shrinks artwork taller than the print area until it fits', () => {
    expect(placeImage(PORTRAIT_AREA, PORTRAIT_ART, { mode: 'contain' })).toEqual({
      image: { x: 0.5, y: 0.5, scale: 0.8333, angle: 0 },
      printedWidth: (5000 / 4000) * (2000 / 3000) * 4000,
    });
  });

  it('contain never scales past the print area width', () => {
    expect(placeImage(PORTRAIT_AREA, LANDSCAPE_ART, { mode: 'contain' }).image).toEqual({
      x: 0.5,
      y: 0.5,
      scale: 1,
      angle: 0,
    });
  });

  it('cover fills the print area in both directions', () => {
    expect(placeImage(PORTRAIT_AREA, PORTRAIT_ART, { mode: 'cover' }).image.scale).toBe(1);
    expect(placeImage(PORTRAIT_AREA, LANDSCAPE_ART, { mode: 'cover' }).image.scale).toBe(1.875);
  });

  it('width sets the scale from width_pct', () => {
    expect(placeImage(PORTRAIT_AREA, PORTRAIT_ART, { mode: 'width', width_pct: 80 })).toEqual({
      image: { x: 0.5, y: 0.5, scale: 0.8, angle: 0 },
      printedWidth: 3200,
    });
  });

  it('top puts the top edge of the artwork at the top of the print area', () => {
    // The artwork is 0.8 × 2/3 = 0.5333 of the print area high, so its centre is at 0.2667.
    expect(
      placeImage(PORTRAIT_AREA, LANDSCAPE_ART, { mode: 'contain', align: 'top' }).image.y,
    ).toBe(0.2667);
  });

  it('offset_y_pct moves the artwork down from either alignment, or up when negative', () => {
    expect(
      placeImage(PORTRAIT_AREA, LANDSCAPE_ART, { mode: 'contain', align: 'top', offset_y_pct: 5 })
        .image.y,
    ).toBe(0.3167);
    expect(
      placeImage(PORTRAIT_AREA, LANDSCAPE_ART, { mode: 'contain', offset_y_pct: -10 }).image.y,
    ).toBe(0.4);
  });

  it('passes angle on', () => {
    expect(
      placeImage(PORTRAIT_AREA, PORTRAIT_ART, { mode: 'contain', angle: 90 }).image.angle,
    ).toBe(90);
  });

  it('passes custom through unchanged, without needing the image size', () => {
    expect(
      placeImage(PORTRAIT_AREA, undefined, {
        mode: 'custom',
        x: 0.31234567,
        y: 0.7,
        scale: 1.2,
        angle: 45,
      }),
    ).toEqual({ image: { x: 0.31234567, y: 0.7, scale: 1.2, angle: 45 }, printedWidth: 4800 });
  });

  it('rounds to 4 decimal places', () => {
    // fit = 4919/3951 × 4000/5000 = 0.99600101…
    const placed = placeImage(
      { width: 3951, height: 4919 },
      { width: 4000, height: 5000 },
      {
        mode: 'contain',
      },
    );
    expect(placed.image.scale).toBe(0.996);
  });

  it('refuses a mode that needs the image size without one', () => {
    expect(() => placeImage(PORTRAIT_AREA, undefined, { mode: 'contain' })).toThrow(
      'placement mode "contain" needs the image size',
    );
  });
});

describe('resolutionWarning', () => {
  const check = { fileName: 'sunset.png', printedWidth: 2000, position: 'front', variantCount: 3 };

  it('says nothing when the image is exactly as wide as it is printed', () => {
    expect(resolutionWarning({ ...check, imageWidth: 2000 })).toBeUndefined();
  });

  it('warns when the image is one pixel narrower', () => {
    expect(resolutionWarning({ ...check, imageWidth: 1999 })).toBe(
      'sunset.png is 1999 px wide but needs 2000 px on front (99%) for 3 variants',
    );
  });

  it('says "1 variant" for one', () => {
    expect(resolutionWarning({ ...check, imageWidth: 500, variantCount: 1 })).toBe(
      'sunset.png is 500 px wide but needs 2000 px on front (25%) for 1 variant',
    );
  });
});
