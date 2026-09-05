import { Screenshot } from '@escrow/shared';
import { UserRow } from '../../db/repos/users.repo';
import { findMatchById } from '../../db/repos/matches.repo';
import { enqueueOcrJob, findScreenshotById, insertScreenshot } from '../../db/repos/misc.repo';
import { evidenceStore } from '../../storage';
import { badRequest, forbidden, notFound } from '../../common/errors';
import { assertParticipant } from '../matches/matches.service';

export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export interface UploadInput {
  matchId: string;
  contentType: string;
  /** Raw image bytes, base64-encoded. */
  dataBase64: string;
  capturedAt?: string | null;
}

/**
 * Stores post-match evidence.
 *
 * The bytes are hashed and written before anything else happens, and the row
 * is immutable afterwards (enforced by a database trigger). Analysis —
 * perceptual hash, OCR, duplicate detection — happens asynchronously in the
 * worker so a slow OCR pass never blocks a player reporting their result.
 */
export async function uploadScreenshot(user: UserRow, input: UploadInput): Promise<Screenshot> {
  if (!ALLOWED_TYPES.has(input.contentType)) {
    throw badRequest('unsupported_type', 'Upload a PNG, JPEG or WebP image');
  }
  const match = await findMatchById(input.matchId);
  if (!match) throw notFound('Match');
  assertParticipant(match, user.id);

  const buffer = Buffer.from(input.dataBase64, 'base64');
  if (buffer.byteLength === 0) throw badRequest('invalid_image', 'Image data is empty or not valid base64');
  if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
    throw badRequest('image_too_large', 'Screenshots are capped at 8 MB');
  }

  const stored = await evidenceStore().put(buffer, input.contentType);
  const screenshot = await insertScreenshot({
    matchId: input.matchId,
    uploaderId: user.id,
    storageKey: stored.storageKey,
    contentType: input.contentType,
    byteSize: stored.byteSize,
    sha256: stored.sha256,
    capturedAt: input.capturedAt ?? null,
  });

  await enqueueOcrJob(screenshot.id);
  return screenshot;
}

export async function getScreenshot(user: UserRow, id: string): Promise<Screenshot> {
  const screenshot = await findScreenshotById(id);
  if (!screenshot) throw notFound('Screenshot');
  const match = await findMatchById(screenshot.matchId);
  if (!match) throw notFound('Match');
  if (user.role === 'player' && match.creatorId !== user.id && match.opponentId !== user.id) {
    throw forbidden('not_a_participant', 'You are not in this match');
  }
  return screenshot;
}

export async function screenshotBytes(
  user: UserRow,
  id: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const screenshot = await getScreenshot(user, id);
  return {
    buffer: await evidenceStore().get(screenshot.storageKey),
    contentType: screenshot.contentType,
  };
}
