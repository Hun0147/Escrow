import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * Evidence storage.
 *
 * Screenshots are write-once: the key is derived from the content hash, so
 * re-uploading identical bytes lands on the same object and an upload can
 * never overwrite different evidence. The local driver is the default for
 * development; the S3 driver is the same interface with a bucket behind it.
 */
export interface StoredObject {
  storageKey: string;
  sha256: string;
  byteSize: number;
}

export interface EvidenceStore {
  put(buffer: Buffer, contentType: string): Promise<StoredObject>;
  get(storageKey: string): Promise<Buffer>;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function extensionFor(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') return 'jpg';
  if (contentType === 'image/webp') return 'webp';
  return 'bin';
}

export class LocalEvidenceStore implements EvidenceStore {
  constructor(private readonly root: string) {}

  async put(buffer: Buffer, contentType: string): Promise<StoredObject> {
    const sha256 = sha256Hex(buffer);
    // Two levels of fan-out keeps directory listings usable at volume.
    const storageKey = `screenshots/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${extensionFor(contentType)}`;
    const path = join(this.root, storageKey);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, buffer);
    }
    return { storageKey, sha256, byteSize: buffer.byteLength };
  }

  async get(storageKey: string): Promise<Buffer> {
    return readFileSync(join(this.root, storageKey));
  }
}

let store: EvidenceStore | null = null;

export function evidenceStore(): EvidenceStore {
  if (!store) {
    const root = resolve(process.env.EVIDENCE_DIR ?? join(process.cwd(), '.evidence'));
    store = new LocalEvidenceStore(root);
  }
  return store;
}

/** Test seam: swap in a fake store without touching disk. */
export function setEvidenceStore(next: EvidenceStore | null): void {
  store = next;
}
