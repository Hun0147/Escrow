import { deflateSync } from 'zlib';
import { encode as encodeJpegBuffer } from 'jpeg-js';

/**
 * Minimal PNG encoder for tests, so the perceptual-hash and OCR pipeline can
 * be exercised against real image bytes rather than a stub.
 */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const offset = y * (stride + 1) + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A deterministic "scoreboard-ish" image: bands and blocks, not noise, so
 *  downscaling it is stable the way a real screenshot is. */
export function scoreboardImage(width = 96, height = 64, seed = 1): Buffer {
  return encodePng(width, height, (x, y) => scoreboardPixel(x, y, width, height, seed));
}

/** The same deterministic scoreboard, encoded as JPEG — what a PS5 share
 *  export actually is. `quality` lets a test simulate a re-encode. */
export function scoreboardJpeg(width = 96, height = 64, seed = 1, quality = 85): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = scoreboardPixel(x, y, width, height, seed);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return Buffer.from(encodeJpegBuffer({ data, width, height }, quality).data);
}

function scoreboardPixel(
  x: number,
  y: number,
  width: number,
  height: number,
  seed: number,
): [number, number, number] {
  const band = Math.floor((y / height) * 8);
  const cell = Math.floor((x / width) * 8);
  const value = ((band * 31 + cell * 17 + seed * 53) % 200) + 20;
  return [value, (value + 40) % 255, (value + 90) % 255];
}
