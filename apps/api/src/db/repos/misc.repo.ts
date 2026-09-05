import {
  ChatMessage,
  Dispute,
  DisputeResolution,
  DisputeStatus,
  KycRecord,
  KycStatus,
  Notification,
  NotificationType,
  Screenshot,
  ScreenshotVerdict,
  TrustEvent,
  TrustEventType,
} from '@escrow/shared';
import { pool } from '../pool';
import { Queryable } from './users.repo';

// ------------------------------------------------------------------ disputes

function mapDispute(row: any): Dispute {
  return {
    id: row.id,
    matchId: row.match_id,
    raisedBy: row.raised_by,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolutionNotes: row.resolution_notes,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

/** One dispute per match: a second escalation joins the existing one rather
 *  than opening a competing case. */
export async function upsertDispute(
  params: { matchId: string; raisedBy: string | null; reason: string },
  db: Queryable = pool,
): Promise<Dispute> {
  const { rows } = await db.query(
    `INSERT INTO disputes (match_id, raised_by, reason) VALUES ($1, $2, $3)
     ON CONFLICT (match_id) DO UPDATE SET reason = disputes.reason || ' | ' || EXCLUDED.reason
     RETURNING *`,
    [params.matchId, params.raisedBy, params.reason],
  );
  return mapDispute(rows[0]);
}

export async function findDisputeById(id: string, db: Queryable = pool): Promise<Dispute | null> {
  const { rows } = await db.query('SELECT * FROM disputes WHERE id = $1', [id]);
  return rows[0] ? mapDispute(rows[0]) : null;
}

export async function findDisputeByMatch(matchId: string, db: Queryable = pool): Promise<Dispute | null> {
  const { rows } = await db.query('SELECT * FROM disputes WHERE match_id = $1', [matchId]);
  return rows[0] ? mapDispute(rows[0]) : null;
}

export async function listDisputes(
  status: DisputeStatus | 'all',
  limit = 50,
  db: Queryable = pool,
): Promise<Dispute[]> {
  const where = status === 'all' ? '' : 'WHERE status = $2';
  const values: unknown[] = status === 'all' ? [limit] : [limit, status];
  const { rows } = await db.query(
    `SELECT * FROM disputes ${where} ORDER BY created_at ASC LIMIT $1`,
    values,
  );
  return rows.map(mapDispute);
}

export async function markDisputeResolved(
  params: {
    id: string;
    resolution: DisputeResolution;
    resolvedBy: string | null;
    notes: string | null;
    status?: DisputeStatus;
  },
  db: Queryable = pool,
): Promise<Dispute> {
  const { rows } = await db.query(
    `UPDATE disputes
     SET status = $5, resolution = $2, resolved_by = $3, resolution_notes = $4, resolved_at = now()
     WHERE id = $1 RETURNING *`,
    [params.id, params.resolution, params.resolvedBy, params.notes, params.status ?? 'resolved'],
  );
  if (!rows[0]) throw new Error('Dispute not found');
  return mapDispute(rows[0]);
}

// --------------------------------------------------------------- screenshots

function mapScreenshot(row: any): Screenshot {
  return {
    id: row.id,
    matchId: row.match_id,
    uploaderId: row.uploader_id,
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    perceptualHash: row.perceptual_hash,
    ocrText: row.ocr_text,
    ocrHomeTag: row.ocr_home_tag,
    ocrAwayTag: row.ocr_away_tag,
    ocrHomeScore: row.ocr_home_score,
    ocrAwayScore: row.ocr_away_score,
    verdict: row.verdict,
    duplicateOfId: row.duplicate_of_id,
    capturedAt: row.captured_at ? row.captured_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertScreenshot(
  params: {
    matchId: string;
    uploaderId: string;
    storageKey: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    capturedAt?: string | null;
  },
  db: Queryable = pool,
): Promise<Screenshot> {
  const { rows } = await db.query(
    `INSERT INTO screenshots (match_id, uploader_id, storage_key, content_type, byte_size, sha256, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      params.matchId,
      params.uploaderId,
      params.storageKey,
      params.contentType,
      params.byteSize,
      params.sha256,
      params.capturedAt ?? null,
    ],
  );
  return mapScreenshot(rows[0]);
}

export async function findScreenshotById(id: string, db: Queryable = pool): Promise<Screenshot | null> {
  const { rows } = await db.query('SELECT * FROM screenshots WHERE id = $1', [id]);
  return rows[0] ? mapScreenshot(rows[0]) : null;
}

export async function listScreenshotsForMatch(matchId: string, db: Queryable = pool): Promise<Screenshot[]> {
  const { rows } = await db.query(
    'SELECT * FROM screenshots WHERE match_id = $1 ORDER BY created_at ASC',
    [matchId],
  );
  return rows.map(mapScreenshot);
}

/** Exact-bytes duplicates: the cheapest check, and it needs no image decoding. */
export async function findScreenshotBySha(
  sha256: string,
  excludeId: string | null,
  db: Queryable = pool,
): Promise<Screenshot | null> {
  const { rows } = await db.query(
    `SELECT * FROM screenshots WHERE sha256 = $1 AND ($2::uuid IS NULL OR id <> $2)
     ORDER BY created_at ASC LIMIT 1`,
    [sha256, excludeId],
  );
  return rows[0] ? mapScreenshot(rows[0]) : null;
}

/** Every other screenshot that already has a perceptual hash, for comparison.
 *  Hamming distance isn't indexable in plain Postgres, so the candidate set is
 *  capped; a production deployment would move this to a BK-tree or pg_trgm-
 *  style index service. */
export async function listHashedScreenshots(
  excludeId: string,
  limit = 5000,
  db: Queryable = pool,
): Promise<Pick<Screenshot, 'id' | 'perceptualHash' | 'uploaderId' | 'matchId'>[]> {
  const { rows } = await db.query(
    `SELECT id, perceptual_hash, uploader_id, match_id FROM screenshots
     WHERE perceptual_hash IS NOT NULL AND id <> $1
     ORDER BY created_at DESC LIMIT $2`,
    [excludeId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    perceptualHash: row.perceptual_hash,
    uploaderId: row.uploader_id,
    matchId: row.match_id,
  }));
}

export async function updateScreenshotAnalysis(
  id: string,
  patch: {
    perceptualHash?: string | null;
    ocrText?: string | null;
    ocrHomeTag?: string | null;
    ocrAwayTag?: string | null;
    ocrHomeScore?: number | null;
    ocrAwayScore?: number | null;
    verdict?: ScreenshotVerdict;
    duplicateOfId?: string | null;
  },
  db: Queryable = pool,
): Promise<Screenshot> {
  const { rows } = await db.query(
    `UPDATE screenshots SET
       perceptual_hash = COALESCE($2, perceptual_hash),
       ocr_text = COALESCE($3, ocr_text),
       ocr_home_tag = COALESCE($4, ocr_home_tag),
       ocr_away_tag = COALESCE($5, ocr_away_tag),
       ocr_home_score = COALESCE($6, ocr_home_score),
       ocr_away_score = COALESCE($7, ocr_away_score),
       verdict = COALESCE($8, verdict),
       duplicate_of_id = COALESCE($9, duplicate_of_id)
     WHERE id = $1 RETURNING *`,
    [
      id,
      patch.perceptualHash ?? null,
      patch.ocrText ?? null,
      patch.ocrHomeTag ?? null,
      patch.ocrAwayTag ?? null,
      patch.ocrHomeScore ?? null,
      patch.ocrAwayScore ?? null,
      patch.verdict ?? null,
      patch.duplicateOfId ?? null,
    ],
  );
  if (!rows[0]) throw new Error('Screenshot not found');
  return mapScreenshot(rows[0]);
}

// ------------------------------------------------------------------ ocr jobs

export interface OcrJob {
  id: string;
  screenshotId: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
}

function mapJob(row: any): OcrJob {
  return {
    id: row.id,
    screenshotId: row.screenshot_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

export async function enqueueOcrJob(screenshotId: string, db: Queryable = pool): Promise<OcrJob> {
  const { rows } = await db.query(
    `INSERT INTO ocr_jobs (screenshot_id) VALUES ($1)
     ON CONFLICT (screenshot_id) DO UPDATE SET status = 'pending', updated_at = now()
     RETURNING *`,
    [screenshotId],
  );
  return mapJob(rows[0]);
}

/**
 * Claims one pending job. `FOR UPDATE SKIP LOCKED` is what lets several worker
 * processes drain the same queue without handing the same job to two of them.
 */
export async function claimOcrJob(db: Queryable = pool): Promise<OcrJob | null> {
  const { rows } = await db.query(
    `UPDATE ocr_jobs SET status = 'processing', attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM ocr_jobs WHERE status = 'pending'
       ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
     )
     RETURNING *`,
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function finishOcrJob(
  id: string,
  status: 'done' | 'failed' | 'pending',
  error: string | null,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    'UPDATE ocr_jobs SET status = $2, last_error = $3, updated_at = now() WHERE id = $1',
    [id, status, error],
  );
}

// -------------------------------------------------------------- trust events

function mapTrustEvent(row: any): TrustEvent {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    matchId: row.match_id,
    delta: row.delta,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertTrustEvent(
  params: { userId: string; type: TrustEventType; matchId?: string | null; delta: number; note?: string | null },
  db: Queryable = pool,
): Promise<TrustEvent> {
  const { rows } = await db.query(
    `INSERT INTO trust_events (user_id, type, match_id, delta, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [params.userId, params.type, params.matchId ?? null, params.delta, params.note ?? null],
  );
  return mapTrustEvent(rows[0]);
}

export async function listTrustEvents(
  userId: string,
  limit = 50,
  db: Queryable = pool,
): Promise<TrustEvent[]> {
  const { rows } = await db.query(
    'SELECT * FROM trust_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit],
  );
  return rows.map(mapTrustEvent);
}

export interface TrustTally {
  matchesSettled: number;
  accurateReports: number;
  inaccurateReports: number;
  disputesRaised: number;
  disputesLost: number;
  cancellations: number;
}

/** Recomputes the inputs to the trust score straight from the event log, so
 *  the score is always reproducible and never a drifting counter. */
export async function tallyTrustEvents(userId: string, db: Queryable = pool): Promise<TrustTally> {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE type = 'match_settled_clean') AS matches_settled,
       COUNT(*) FILTER (WHERE type = 'report_accurate') AS accurate_reports,
       COUNT(*) FILTER (WHERE type IN ('report_inaccurate', 'report_timeout')) AS inaccurate_reports,
       COUNT(*) FILTER (WHERE type = 'dispute_raised') AS disputes_raised,
       COUNT(*) FILTER (WHERE type = 'dispute_lost') AS disputes_lost,
       COUNT(*) FILTER (WHERE type = 'match_cancelled') AS cancellations
     FROM trust_events WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  return {
    matchesSettled: Number(row.matches_settled),
    accurateReports: Number(row.accurate_reports),
    inaccurateReports: Number(row.inaccurate_reports),
    disputesRaised: Number(row.disputes_raised),
    disputesLost: Number(row.disputes_lost),
    cancellations: Number(row.cancellations),
  };
}

// ----------------------------------------------------------------------- kyc

function mapKyc(row: any): KycRecord {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    documentType: row.document_type,
    documentRef: row.document_ref,
    selfieRef: row.selfie_ref,
    addressCountry: row.address_country,
    addressRegion: row.address_region,
    reviewedBy: row.reviewed_by,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at.toISOString(),
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
  };
}

export async function insertKycRecord(
  params: {
    userId: string;
    documentType: string;
    documentRef: string;
    selfieRef: string;
    addressCountry: string;
    addressRegion: string | null;
  },
  db: Queryable = pool,
): Promise<KycRecord> {
  const { rows } = await db.query(
    `INSERT INTO kyc_records (user_id, document_type, document_ref, selfie_ref, address_country, address_region)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      params.userId,
      params.documentType,
      params.documentRef,
      params.selfieRef,
      params.addressCountry,
      params.addressRegion,
    ],
  );
  return mapKyc(rows[0]);
}

export async function findKycById(id: string, db: Queryable = pool): Promise<KycRecord | null> {
  const { rows } = await db.query('SELECT * FROM kyc_records WHERE id = $1', [id]);
  return rows[0] ? mapKyc(rows[0]) : null;
}

export async function latestKycForUser(userId: string, db: Queryable = pool): Promise<KycRecord | null> {
  const { rows } = await db.query(
    'SELECT * FROM kyc_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId],
  );
  return rows[0] ? mapKyc(rows[0]) : null;
}

export async function listPendingKyc(limit = 50, db: Queryable = pool): Promise<KycRecord[]> {
  const { rows } = await db.query(
    "SELECT * FROM kyc_records WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1",
    [limit],
  );
  return rows.map(mapKyc);
}

export async function reviewKyc(
  params: { id: string; status: KycStatus; reviewedBy: string; rejectionReason: string | null },
  db: Queryable = pool,
): Promise<KycRecord> {
  const { rows } = await db.query(
    `UPDATE kyc_records SET status = $2, reviewed_by = $3, rejection_reason = $4, reviewed_at = now()
     WHERE id = $1 RETURNING *`,
    [params.id, params.status, params.reviewedBy, params.rejectionReason],
  );
  if (!rows[0]) throw new Error('KYC record not found');
  return mapKyc(rows[0]);
}

// -------------------------------------------------------------- engagement

function mapNotification(row: any): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    matchId: row.match_id,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertNotification(
  params: { userId: string; type: NotificationType; title: string; body: string; matchId?: string | null },
  db: Queryable = pool,
): Promise<Notification> {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, type, title, body, match_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [params.userId, params.type, params.title, params.body, params.matchId ?? null],
  );
  return mapNotification(rows[0]);
}

export async function listNotifications(
  userId: string,
  limit = 50,
  db: Queryable = pool,
): Promise<Notification[]> {
  const { rows } = await db.query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit],
  );
  return rows.map(mapNotification);
}

export async function markNotificationsRead(userId: string, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [
    userId,
  ]);
}

function mapChat(row: any): ChatMessage {
  return {
    id: row.id,
    matchId: row.match_id,
    userId: row.user_id,
    handle: row.handle ?? '',
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertChatMessage(
  params: { matchId: string; userId: string; body: string },
  db: Queryable = pool,
): Promise<ChatMessage> {
  const { rows } = await db.query(
    `INSERT INTO chat_messages (match_id, user_id, body) VALUES ($1, $2, $3)
     RETURNING *, (SELECT handle FROM users WHERE id = $2) AS handle`,
    [params.matchId, params.userId, params.body],
  );
  return mapChat(rows[0]);
}

export async function listChatMessages(
  matchId: string,
  limit = 200,
  db: Queryable = pool,
): Promise<ChatMessage[]> {
  const { rows } = await db.query(
    `SELECT c.*, u.handle FROM chat_messages c
     JOIN users u ON u.id = c.user_id
     WHERE c.match_id = $1 ORDER BY c.created_at ASC LIMIT $2`,
    [matchId, limit],
  );
  return rows.map(mapChat);
}
