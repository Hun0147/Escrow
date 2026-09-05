import {
  DUPLICATE_HAMMING_THRESHOLD,
  ScreenshotVerdict,
  compareOcrToReport,
  dHash,
  hammingDistance,
  parseScoreboard,
} from '@escrow/shared';
import {
  claimOcrJob,
  finishOcrJob,
  findScreenshotById,
  findScreenshotBySha,
  listHashedScreenshots,
  updateScreenshotAnalysis,
} from '../db/repos/misc.repo';
import { listResults, findMatchById } from '../db/repos/matches.repo';
import { findUserById } from '../db/repos/users.repo';
import { raiseFraudFlag } from '../db/repos/fraud.repo';
import { evidenceStore } from '../storage';
import { decodeToGrayscale } from '../ocr/image';
import { ocrEngine } from '../ocr/engine';
import { realtime } from '../realtime/bus';

export interface OcrOutcome {
  screenshotId: string;
  verdict: ScreenshotVerdict;
  perceptualHash: string | null;
  flags: string[];
}

/**
 * Analyses one uploaded screenshot.
 *
 * Order matters: hash first (cheap, catches recycled evidence), then OCR
 * (expensive, catches a fabricated scoreline). A duplicate verdict is final —
 * there is no point reading a screenshot we have already seen.
 */
export async function processScreenshot(screenshotId: string): Promise<OcrOutcome> {
  const screenshot = await findScreenshotById(screenshotId);
  if (!screenshot) throw new Error(`Screenshot ${screenshotId} not found`);

  const flags: string[] = [];
  const buffer = await evidenceStore().get(screenshot.storageKey);

  // 1. Byte-identical re-upload.
  const exact = await findScreenshotBySha(screenshot.sha256, screenshot.id);
  if (exact) {
    await flagDuplicate(screenshot.id, exact.id, screenshot.uploaderId, 'identical bytes');
    return { screenshotId, verdict: 'duplicate', perceptualHash: null, flags: ['duplicate_exact'] };
  }

  // 2. Perceptually identical — a crop, a re-encode, a re-photograph.
  const gray = decodeToGrayscale(buffer, screenshot.contentType);
  let perceptualHash: string | null = null;
  if (gray) {
    perceptualHash = dHash(gray);
    await updateScreenshotAnalysis(screenshot.id, { perceptualHash });

    for (const other of await listHashedScreenshots(screenshot.id)) {
      if (!other.perceptualHash || other.perceptualHash.length !== perceptualHash.length) continue;
      if (hammingDistance(perceptualHash, other.perceptualHash) <= DUPLICATE_HAMMING_THRESHOLD) {
        await flagDuplicate(screenshot.id, other.id, screenshot.uploaderId, 'perceptually identical');
        return { screenshotId, verdict: 'duplicate', perceptualHash, flags: ['duplicate_perceptual'] };
      }
    }
  } else {
    flags.push('undecodable_for_hashing');
  }

  // 3. Read the scoreboard and check it against what the player typed.
  const text = await ocrEngine().recognise(buffer, screenshot.contentType);
  const parsed = parseScoreboard(text);

  const results = await listResults(screenshot.matchId);
  const report = results.find((r) => r.reporterId === screenshot.uploaderId);
  const match = await findMatchById(screenshot.matchId);
  const uploader = await findUserById(screenshot.uploaderId);
  const opponentId =
    match && match.creatorId === screenshot.uploaderId ? match.opponentId : match?.creatorId ?? null;
  const opponent = opponentId ? await findUserById(opponentId) : null;

  let verdict: ScreenshotVerdict = 'pending';
  if (!report) {
    // Uploaded ahead of the typed result: record what we read and leave the
    // verdict open until the report arrives.
    verdict = parsed.homeScore === null ? 'unreadable' : 'pending';
  } else {
    const comparison = compareOcrToReport(
      parsed,
      { selfScore: report.selfScore, opponentScore: report.opponentScore },
      { reporterPsnId: uploader?.psnId ?? null, opponentPsnId: opponent?.psnId ?? null },
    );
    flags.push(...comparison.flags);
    verdict = !comparison.readable ? 'unreadable' : comparison.scoreMatches ? 'match' : 'mismatch';
  }

  await updateScreenshotAnalysis(screenshot.id, {
    perceptualHash,
    ocrText: text || null,
    ocrHomeTag: parsed.homeTag,
    ocrAwayTag: parsed.awayTag,
    ocrHomeScore: parsed.homeScore,
    ocrAwayScore: parsed.awayScore,
    verdict,
  });

  if (verdict === 'mismatch') {
    await raiseFraudFlag({
      userId: screenshot.uploaderId,
      kind: 'ocr_score_mismatch',
      detail: `Screenshot ${screenshot.id} reads ${parsed.homeScore}-${parsed.awayScore}, player reported ${report?.selfScore}-${report?.opponentScore}`,
    });
  }

  realtime.toMatch(screenshot.matchId, 'screenshot:analysed', {
    screenshotId: screenshot.id,
    verdict,
    flags,
  });

  return { screenshotId, verdict, perceptualHash, flags };
}

async function flagDuplicate(
  screenshotId: string,
  originalId: string,
  uploaderId: string,
  detail: string,
): Promise<void> {
  await updateScreenshotAnalysis(screenshotId, {
    verdict: 'duplicate',
    duplicateOfId: originalId,
  });
  await raiseFraudFlag({
    userId: uploaderId,
    kind: 'duplicate_screenshot',
    detail: `Screenshot ${screenshotId} is ${detail} to ${originalId}`,
  });
}

/** Drains the queue. Returns how many jobs were processed. */
export async function drainOcrQueue(max = 25): Promise<number> {
  let processed = 0;
  for (let i = 0; i < max; i++) {
    const job = await claimOcrJob();
    if (!job) break;
    try {
      await processScreenshot(job.screenshotId);
      await finishOcrJob(job.id, 'done', null);
    } catch (err) {
      // Three attempts, then it stays failed and shows up in the admin view —
      // a screenshot we cannot analyse is a moderator's problem, not a silent
      // pass.
      const message = (err as Error).message;
      await finishOcrJob(job.id, job.attempts >= 3 ? 'failed' : 'pending', message);
    }
    processed++;
  }
  return processed;
}
