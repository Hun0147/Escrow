/**
 * OCR engine seam.
 *
 * The platform's risk sits in *interpreting* the screenshot, and that logic
 * (`parseScoreboard` in the shared package) is engine-independent. This
 * interface is deliberately tiny so a real engine — Tesseract, Textract,
 * Vision — drops in without touching the verification pipeline.
 */
export interface OcrEngine {
  readonly name: string;
  recognise(buffer: Buffer, contentType: string): Promise<string>;
}

/**
 * Development engine. It reads a text sidecar embedded in the upload rather
 * than doing real recognition, so the whole verification pipeline — parse,
 * compare, flag, hold — can be exercised end to end without shipping a large
 * language model into CI.
 *
 * The convention: the bytes contain a `GOAL27-OCR:` marker followed by the
 * base64 of the text a real engine would have returned.
 */
export class SidecarOcrEngine implements OcrEngine {
  readonly name = 'sidecar';

  static readonly MARKER = 'GOAL27-OCR:';

  /** Builds an image-plus-sidecar payload for tests and local development. */
  static embed(image: Buffer, ocrText: string): Buffer {
    return Buffer.concat([
      image,
      Buffer.from(`${SidecarOcrEngine.MARKER}${Buffer.from(ocrText, 'utf8').toString('base64')};`, 'latin1'),
    ]);
  }

  async recognise(buffer: Buffer): Promise<string> {
    const text = buffer.toString('latin1');
    const index = text.indexOf(SidecarOcrEngine.MARKER);
    if (index === -1) return '';
    const rest = text.slice(index + SidecarOcrEngine.MARKER.length);
    const end = rest.indexOf(';');
    const encoded = end === -1 ? rest : rest.slice(0, end);
    return Buffer.from(encoded, 'base64').toString('utf8');
  }
}

/**
 * Real OCR via tesseract.js, loaded lazily so the dependency stays optional:
 * set OCR_ENGINE=tesseract and install it to switch the worker over.
 */
export class TesseractOcrEngine implements OcrEngine {
  readonly name = 'tesseract';

  async recognise(buffer: Buffer): Promise<string> {
    const mod = await import('tesseract.js' as string).catch(() => null);
    if (!mod) {
      throw new Error('OCR_ENGINE=tesseract requires the optional tesseract.js dependency');
    }
    const { data } = await (mod as any).recognize(buffer, 'eng');
    return String(data?.text ?? '');
  }
}

let engine: OcrEngine | null = null;

export function ocrEngine(): OcrEngine {
  if (!engine) {
    engine = process.env.OCR_ENGINE === 'tesseract' ? new TesseractOcrEngine() : new SidecarOcrEngine();
  }
  return engine;
}

/** Test seam. */
export function setOcrEngine(next: OcrEngine | null): void {
  engine = next;
}
