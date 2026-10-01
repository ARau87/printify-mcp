/** A pixel size: a placeholder's or an image's. */
export interface Size {
  width: number;
  height: number;
}

export type Align = 'center' | 'top';

/** Where a design's artwork goes, as the tool takes it. */
export type Placement =
  | {
      mode: 'contain' | 'cover';
      align?: Align | undefined;
      offset_y_pct?: number | undefined;
      angle?: number | undefined;
    }
  | {
      mode: 'width';
      width_pct: number;
      align?: Align | undefined;
      offset_y_pct?: number | undefined;
      angle?: number | undefined;
    }
  | { mode: 'custom'; x: number; y: number; scale: number; angle?: number | undefined };

/** One image's position in one placeholder, as `print_areas` takes it. */
export interface ImagePlacement {
  x: number;
  y: number;
  scale: number;
  angle: number;
}

export interface Placed {
  /** Rounded to 4 decimal places, except `custom`, which is passed through. */
  image: ImagePlacement;
  /** The printed width in placeholder pixels, before rounding: what the resolution check uses. */
  printedWidth: number;
}

export const DEFAULT_PLACEMENT: Placement = { mode: 'contain' };

/**
 * Places an image in a placeholder. Printify's `x` and `y` are the image centre as a fraction of
 * the placeholder, and `scale` is the image width divided by the placeholder width. `image` may
 * be undefined only for `custom`, which needs no image size.
 */
export function placeImage(
  placeholder: Size,
  image: Size | undefined,
  placement: Placement,
): Placed {
  const angle = placement.angle ?? 0;
  if (placement.mode === 'custom') {
    const { x, y, scale } = placement;
    return { image: { x, y, scale, angle }, printedWidth: scale * placeholder.width };
  }
  if (image === undefined) {
    throw new TypeError(`placement mode "${placement.mode}" needs the image size`);
  }
  const scale = scaleFor(placeholder, image, placement);
  // The image height as a fraction of the placeholder height.
  const heightFraction =
    scale * (placeholder.width / placeholder.height) * (image.height / image.width);
  const top = placement.align === 'top' ? heightFraction / 2 : 0.5;
  const y = top + (placement.offset_y_pct ?? 0) / 100;
  return {
    image: { x: 0.5, y: round(y), scale: round(scale), angle },
    printedWidth: scale * placeholder.width,
  };
}

function scaleFor(
  placeholder: Size,
  image: Size,
  placement: Exclude<Placement, { mode: 'custom' }>,
): number {
  if (placement.mode === 'width') return placement.width_pct / 100;
  // The scale at which the image height equals the placeholder height.
  const fit = (placeholder.height / placeholder.width) * (image.width / image.height);
  return placement.mode === 'contain' ? Math.min(1, fit) : Math.max(1, fit);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export interface ResolutionCheck {
  fileName: string;
  imageWidth: number;
  printedWidth: number;
  position: string;
  variantCount: number;
}

/**
 * A warning when the image has fewer pixels than it is printed across, else undefined. Printify
 * does not publish the threshold of its error 8203, so this catches the obvious cases only.
 */
export function resolutionWarning(check: ResolutionCheck): string | undefined {
  const { fileName, imageWidth, printedWidth, position, variantCount } = check;
  if (imageWidth >= printedWidth) return undefined;
  const needed = Math.ceil(printedWidth);
  const percent = Math.floor((imageWidth / printedWidth) * 100);
  const variants = `${String(variantCount)} variant${variantCount === 1 ? '' : 's'}`;
  return (
    `${fileName} is ${String(imageWidth)} px wide but needs ${String(needed)} px on ${position} ` +
    `(${String(percent)}%) for ${variants}`
  );
}
