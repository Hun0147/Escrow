import { inflateSync } from 'zlib';
import { GrayscaleImage, toGrayscale } from '@escrow/shared';

/**
 * Minimal image decoding, enough to feed the perceptual hash.
 *
 * Only PNG is decoded natively (non-interlaced, 8-bit, the format the web
 * uploader produces). JPEG — what a PS5 share export actually is — needs a
 * real decoder; `decodeToGrayscale` returns null for anything it cannot read
 * and callers fall back to content hashing alone, which still catches an
 * exact re-upload. Wiring in a JPEG decoder is a drop-in here and nowhere else.
 */
export function decodeToGrayscale(buffer: Buffer, contentType: string): GrayscaleImage | null {
  if (contentType === 'image/png' || isPng(buffer)) {
    try {
      return decodePng(buffer);
    } catch {
      return null;
    }
  }
  return null;
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  );
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(buffer: Buffer): GrayscaleImage {
  let offset = 8;
  let header: PngHeader | null = null;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!header) throw new Error('PNG has no header chunk');
  if (header.bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${header.bitDepth}`);
  if (header.interlace !== 0) throw new Error('Interlaced PNG is not supported');

  const channels = CHANNELS[header.colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${header.colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = header.colorType === 3 ? 1 : channels;
  const stride = header.width * bytesPerPixel;
  const pixels = unfilter(raw, header.height, stride, bytesPerPixel);

  const rgba = new Uint8Array(header.width * header.height * 4);
  for (let i = 0; i < header.width * header.height; i++) {
    const source = i * bytesPerPixel;
    let r: number;
    let g: number;
    let b: number;
    if (header.colorType === 3) {
      if (!palette) throw new Error('Indexed PNG without a palette');
      const index = pixels[source] * 3;
      r = palette[index];
      g = palette[index + 1];
      b = palette[index + 2];
    } else if (header.colorType === 0 || header.colorType === 4) {
      r = g = b = pixels[source];
    } else {
      r = pixels[source];
      g = pixels[source + 1];
      b = pixels[source + 2];
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }

  return toGrayscale(rgba, header.width, header.height);
}

/** Reverses the per-scanline PNG filters (spec section 9.2). */
function unfilter(raw: Buffer, height: number, stride: number, bpp: number): Buffer {
  const out = Buffer.alloc(height * stride);
  let rawOffset = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rawOffset++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const value = raw[rawOffset + x];
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;

      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`Unknown PNG filter ${filter}`);
      }
      out[rowStart + x] = restored & 0xff;
    }
    rawOffset += stride;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
