/**
 * Perceptual hashing for screenshot de-duplication (dHash).
 *
 * A cropped, re-compressed or lightly resized copy of a screenshot produces a
 * different SHA-256 but a near-identical dHash, so this is what catches a
 * player re-submitting last week's win as today's.
 *
 * Pure functions over a grayscale bitmap — decoding PNG/JPEG bytes into that
 * bitmap is the caller's job, which keeps this module testable without any
 * image library.
 */

export interface GrayscaleImage {
  width: number;
  height: number;
  /** Row-major luminance, one byte per pixel. */
  data: Uint8Array;
}

/** Hamming distance at or below this counts as the same screenshot. */
export const DUPLICATE_HAMMING_THRESHOLD = 6;

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

export function toGrayscale(rgba: Uint8Array, width: number, height: number): GrayscaleImage {
  if (rgba.length < width * height * 4) {
    throw new Error('RGBA buffer is too small for the given dimensions');
  }
  const data = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    // Rec. 601 luma — matches what the eye weights, so a colour-shifted
    // re-encode still lands on the same hash. Rounded, not truncated, so pure
    // white stays 255 instead of drifting a level down.
    data[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { width, height, data };
}

/** Box-average downscale. Averaging (not sampling) keeps the hash stable
 *  across the resolution changes a share-factory export introduces. */
export function resizeGray(image: GrayscaleImage, width: number, height: number): GrayscaleImage {
  if (width <= 0 || height <= 0) throw new Error('Target dimensions must be positive');
  const out = new Uint8Array(width * height);
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < Math.min(y1, image.height); yy++) {
        for (let xx = x0; xx < Math.min(x1, image.width); xx++) {
          sum += image.data[yy * image.width + xx];
          count++;
        }
      }
      out[y * width + x] = count > 0 ? Math.round(sum / count) : 0;
    }
  }
  return { width, height, data: out };
}

/** 64-bit difference hash, returned as 16 lowercase hex characters. */
export function dHash(image: GrayscaleImage): string {
  const small = resizeGray(image, HASH_WIDTH, HASH_HEIGHT);
  let hex = '';
  let nibble = 0;
  let bitsInNibble = 0;

  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const left = small.data[y * HASH_WIDTH + x];
      const right = small.data[y * HASH_WIDTH + x + 1];
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      bitsInNibble++;
      if (bitsInNibble === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bitsInNibble = 0;
      }
    }
  }
  return hex;
}

export function hammingDistance(hexA: string, hexB: string): number {
  if (hexA.length !== hexB.length) {
    throw new Error('Hashes must be the same length to compare');
  }
  let distance = 0;
  for (let i = 0; i < hexA.length; i++) {
    const a = parseInt(hexA[i], 16);
    const b = parseInt(hexB[i], 16);
    if (Number.isNaN(a) || Number.isNaN(b)) throw new Error('Hashes must be hexadecimal');
    let diff = a ^ b;
    while (diff) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}

export function isPerceptualDuplicate(
  hexA: string,
  hexB: string,
  threshold: number = DUPLICATE_HAMMING_THRESHOLD,
): boolean {
  return hammingDistance(hexA, hexB) <= threshold;
}
