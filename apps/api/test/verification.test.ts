import {
  DUPLICATE_HAMMING_THRESHOLD,
  compareOcrToReport,
  dHash,
  hammingDistance,
  parseScoreboard,
  toGrayscale,
} from '@escrow/shared';
import { decodeToGrayscale } from '../src/ocr/image';
import { SidecarOcrEngine } from '../src/ocr/engine';
import { encodePng, scoreboardImage, scoreboardJpeg } from './png';
import { makeUser, ULTIMATE_TEAM } from './factories';
import { createMatch, joinMatch } from '../src/modules/matches/matches.service';
import { uploadScreenshot } from '../src/modules/screenshots/screenshots.service';
import { submitResult, sweepLapsedMatches } from '../src/modules/results/results.service';
import { drainOcrQueue } from '../src/queue/ocr-worker';
import { findScreenshotById, listScreenshotsForMatch } from '../src/db/repos/misc.repo';
import { listOpenFraudFlags } from '../src/db/repos/fraud.repo';
import { findMatchById, updateMatch } from '../src/db/repos/matches.repo';
import { accountBalance, getWallet, reconcileWallets } from '../src/db/repos/ledger.repo';
import { matchEscrow } from '@escrow/shared';

const FUT_SCREEN = `FULL TIME
MATCH FACTS
Striker_Sam    3 - 1    KeeperKate
Possession 54% 46%
Shots 12 8`;

describe('perceptual hashing', () => {
  it('gives the same hash to an image re-encoded at a different size', () => {
    const large = decodeToGrayscale(scoreboardImage(192, 128), 'image/png')!;
    const small = decodeToGrayscale(scoreboardImage(96, 64), 'image/png')!;
    expect(hammingDistance(dHash(large), dHash(small))).toBeLessThanOrEqual(
      DUPLICATE_HAMMING_THRESHOLD,
    );
  });

  it('separates two genuinely different screenshots', () => {
    const a = decodeToGrayscale(scoreboardImage(96, 64, 1), 'image/png')!;
    const b = decodeToGrayscale(scoreboardImage(96, 64, 9), 'image/png')!;
    expect(hammingDistance(dHash(a), dHash(b))).toBeGreaterThan(DUPLICATE_HAMMING_THRESHOLD);
  });

  it('produces a 16-character hex hash', () => {
    const image = toGrayscale(new Uint8Array(32 * 32 * 4).fill(120), 32, 32);
    expect(dHash(image)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses to compare hashes of different lengths', () => {
    expect(() => hammingDistance('abcd', 'abcdef')).toThrow(/same length/);
  });

  it('decodes a JPEG — the format a PS5 share export actually is', () => {
    const gray = decodeToGrayscale(scoreboardJpeg(96, 64), 'image/jpeg');
    expect(gray).not.toBeNull();
    expect(gray!.width).toBe(96);
    expect(gray!.height).toBe(64);
  });

  it('matches a JPEG re-encode of the same screenshot across quality settings', () => {
    const original = decodeToGrayscale(scoreboardJpeg(192, 128, 4, 92), 'image/jpeg')!;
    const recompressed = decodeToGrayscale(scoreboardJpeg(96, 64, 4, 55), 'image/jpeg')!;
    expect(hammingDistance(dHash(original), dHash(recompressed))).toBeLessThanOrEqual(
      DUPLICATE_HAMMING_THRESHOLD,
    );
  });

  it('lands a JPEG and a PNG of the same screen on the same hash', () => {
    const png = decodeToGrayscale(scoreboardImage(96, 64, 6), 'image/png')!;
    const jpeg = decodeToGrayscale(scoreboardJpeg(96, 64, 6, 90), 'image/jpeg')!;
    expect(hammingDistance(dHash(png), dHash(jpeg))).toBeLessThanOrEqual(
      DUPLICATE_HAMMING_THRESHOLD,
    );
  });

  it('sniffs the real format rather than trusting the declared content type', () => {
    // A JPEG mislabelled as a PNG must still be hashed, not silently skipped.
    const gray = decodeToGrayscale(scoreboardJpeg(64, 48), 'image/png');
    expect(gray).not.toBeNull();
    expect(gray!.width).toBe(64);
  });

  it('returns null rather than throwing on bytes it cannot read', () => {
    expect(decodeToGrayscale(Buffer.from('not an image at all'), 'image/png')).toBeNull();
    expect(decodeToGrayscale(Buffer.alloc(0), 'image/jpeg')).toBeNull();
  });

  it('decodes a real PNG down to luminance', () => {
    const png = encodePng(4, 2, () => [255, 255, 255]);
    const gray = decodeToGrayscale(png, 'image/png');
    expect(gray).not.toBeNull();
    expect(gray!.width).toBe(4);
    expect(gray!.height).toBe(2);
    expect([...gray!.data]).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
  });
});

describe('scoreboard OCR parsing', () => {
  it('reads the scoreline and both gamertags off a FUT match-facts screen', () => {
    const parsed = parseScoreboard(FUT_SCREEN);
    expect(parsed.homeScore).toBe(3);
    expect(parsed.awayScore).toBe(1);
    expect(parsed.homeTag).toBe('Striker_Sam');
    expect(parsed.awayTag).toBe('KeeperKate');
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('copes with a stacked layout and OCR punctuation noise', () => {
    const parsed = parseScoreboard(`FULL TIME\nStriker_Sam\n2 : 2\nKeeperKate`);
    expect(parsed.homeScore).toBe(2);
    expect(parsed.awayScore).toBe(2);
    expect(parsed.homeTag).toBe('Striker_Sam');
    expect(parsed.awayTag).toBe('KeeperKate');
  });

  it('ignores stat lines that merely look like a scoreline', () => {
    const parsed = parseScoreboard('Possession 54 - 46\nFULL TIME\nSam_A 1 - 0 Kate_B');
    // 54-46 is rejected as out of range for a football score.
    expect(parsed.homeScore).toBe(1);
    expect(parsed.awayScore).toBe(0);
  });

  it('reports no confidence when there is nothing to read', () => {
    const parsed = parseScoreboard('');
    expect(parsed.homeScore).toBeNull();
    expect(parsed.confidence).toBe(0);
  });
});

describe('comparing OCR to the typed result', () => {
  const tags = { reporterPsnId: 'Striker_Sam', opponentPsnId: 'KeeperKate' };

  it('accepts a screenshot that backs up the report, either way round', () => {
    const parsed = parseScoreboard(FUT_SCREEN);
    expect(compareOcrToReport(parsed, { selfScore: 3, opponentScore: 1 }, tags).scoreMatches).toBe(true);
    expect(compareOcrToReport(parsed, { selfScore: 1, opponentScore: 3 }, tags).scoreMatches).toBe(true);
    expect(compareOcrToReport(parsed, { selfScore: 3, opponentScore: 1 }, tags).gamertagsMatch).toBe(true);
  });

  it('flags a scoreline the screenshot does not support', () => {
    const comparison = compareOcrToReport(
      parseScoreboard(FUT_SCREEN),
      { selfScore: 5, opponentScore: 0 },
      tags,
    );
    expect(comparison.scoreMatches).toBe(false);
    expect(comparison.flags).toContain('score_mismatch');
  });

  it('flags a screenshot from a match between other players', () => {
    const comparison = compareOcrToReport(parseScoreboard(FUT_SCREEN), { selfScore: 3, opponentScore: 1 }, {
      reporterPsnId: 'SomeoneElse',
      opponentPsnId: 'AndAnother',
    });
    expect(comparison.gamertagsMatch).toBe(false);
    expect(comparison.flags).toContain('gamertag_mismatch');
  });

  it('says so plainly when the image is unreadable', () => {
    const comparison = compareOcrToReport(parseScoreboard('blurry nonsense'), { selfScore: 1, opponentScore: 0 }, tags);
    expect(comparison.readable).toBe(false);
    expect(comparison.flags).toContain('ocr_unreadable');
  });
});

describe('screenshot pipeline', () => {

  let pairNumber = 0;
  beforeEach(() => {
    pairNumber = 0;
  });

  async function playersAndMatch(trust = 90) {
    // PSN IDs are globally unique, so each pair needs its own.
    pairNumber += 1;
    const creator = await makeUser({
      balanceCents: 5000,
      trustScore: trust,
      psnId: pairNumber === 1 ? 'Striker_Sam' : `Striker_Sam${pairNumber}`,
    });
    const opponent = await makeUser({
      balanceCents: 5000,
      trustScore: trust,
      psnId: pairNumber === 1 ? 'KeeperKate' : `KeeperKate${pairNumber}`,
    });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);
    return { creator, opponent, match };
  }

  function upload(image: Buffer, ocrText: string): string {
    return SidecarOcrEngine.embed(image, ocrText).toString('base64');
  }

  it('stores evidence immutably with a content hash and queues it for analysis', async () => {
    const { creator, match } = await playersAndMatch();
    const screenshot = await uploadScreenshot(creator, {
      matchId: match.id,
      contentType: 'image/png',
      dataBase64: upload(scoreboardImage(), FUT_SCREEN),
    });

    expect(screenshot.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(screenshot.verdict).toBe('pending');

    const { pool } = await import('../src/db/pool');
    await expect(
      pool.query('UPDATE screenshots SET sha256 = $2 WHERE id = $1', [screenshot.id, 'tampered']),
    ).rejects.toThrow(/immutable/);
  });

  it('confirms a screenshot that matches the typed result', async () => {
    const { creator, match } = await playersAndMatch();
    const screenshot = await uploadScreenshot(creator, {
      matchId: match.id,
      contentType: 'image/png',
      dataBase64: upload(scoreboardImage(), FUT_SCREEN),
    });
    await submitResult(creator, {
      matchId: match.id,
      selfScore: 3,
      opponentScore: 1,
      screenshotId: screenshot.id,
    });

    await drainOcrQueue();
    const analysed = await findScreenshotById(screenshot.id);
    expect(analysed!.verdict).toBe('match');
    expect(analysed!.ocrHomeScore).toBe(3);
    expect(analysed!.ocrHomeTag).toBe('Striker_Sam');
    expect(analysed!.perceptualHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('catches a recycled screenshot and raises a fraud flag', async () => {
    const first = await playersAndMatch();
    const image = scoreboardImage(96, 64, 3);
    const firstShot = await uploadScreenshot(first.creator, {
      matchId: first.match.id,
      contentType: 'image/png',
      dataBase64: upload(image, FUT_SCREEN),
    });
    await drainOcrQueue();

    // Same player, new match, the very same screenshot.
    const second = await createMatch(first.creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(first.opponent, second.id);
    const reused = await uploadScreenshot(first.creator, {
      matchId: second.id,
      contentType: 'image/png',
      dataBase64: upload(image, FUT_SCREEN),
    });
    await drainOcrQueue();

    const analysed = await findScreenshotById(reused.id);
    expect(analysed!.verdict).toBe('duplicate');
    expect(analysed!.duplicateOfId).toBe(firstShot.id);

    const flags = await listOpenFraudFlags();
    expect(flags.map((f) => f.kind)).toContain('duplicate_screenshot');
  });

  it('catches a JPEG re-upload of an earlier screenshot', async () => {
    const first = await playersAndMatch();
    await uploadScreenshot(first.creator, {
      matchId: first.match.id,
      contentType: 'image/jpeg',
      dataBase64: upload(scoreboardJpeg(192, 128, 13, 90), FUT_SCREEN),
    });
    await drainOcrQueue();

    const second = await createMatch(first.creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(first.opponent, second.id);
    // Rescaled and recompressed: different bytes, different sha256, same match.
    const reused = await uploadScreenshot(first.creator, {
      matchId: second.id,
      contentType: 'image/jpeg',
      dataBase64: upload(scoreboardJpeg(96, 64, 13, 60), FUT_SCREEN),
    });
    await drainOcrQueue();

    expect((await findScreenshotById(reused.id))!.verdict).toBe('duplicate');
  });

  it('catches a crop of an earlier screenshot, not just an identical file', async () => {
    const first = await playersAndMatch();
    await uploadScreenshot(first.creator, {
      matchId: first.match.id,
      contentType: 'image/png',
      dataBase64: upload(scoreboardImage(192, 128, 5), FUT_SCREEN),
    });
    await drainOcrQueue();

    const second = await createMatch(first.creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(first.opponent, second.id);
    // Different bytes, different sha256 — same picture.
    const rescaled = await uploadScreenshot(first.creator, {
      matchId: second.id,
      contentType: 'image/png',
      dataBase64: upload(scoreboardImage(96, 64, 5), FUT_SCREEN),
    });
    await drainOcrQueue();

    expect((await findScreenshotById(rescaled.id))!.verdict).toBe('duplicate');
  });

  it('flags a screenshot whose scoreline contradicts the report', async () => {
    const { creator, match } = await playersAndMatch();
    const screenshot = await uploadScreenshot(creator, {
      matchId: match.id,
      contentType: 'image/png',
      dataBase64: upload(scoreboardImage(96, 64, 7), FUT_SCREEN),
    });
    await submitResult(creator, {
      matchId: match.id,
      selfScore: 5,
      opponentScore: 0,
      screenshotId: screenshot.id,
    });
    await drainOcrQueue();

    const analysed = await findScreenshotById(screenshot.id);
    expect(analysed!.verdict).toBe('mismatch');
    expect((await listOpenFraudFlags()).map((f) => f.kind)).toContain('ocr_score_mismatch');
  });

  it('holds escrow for a mid-trust pair until both screenshots are in', async () => {
    const creator = await makeUser({ balanceCents: 5000, trustScore: 60, psnId: 'Striker_Sam' });
    const opponent = await makeUser({ balanceCents: 5000, trustScore: 62, psnId: 'KeeperKate' });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);

    await submitResult(creator, { matchId: match.id, selfScore: 3, opponentScore: 1 });
    const held = await submitResult(opponent, { matchId: match.id, selfScore: 1, opponentScore: 3 });

    expect(held.status).toBe('held_for_review');
    expect(held.detail).toMatch(/screenshot/i);
    expect(await accountBalance(matchEscrow(match.id))).toBe(2000);
    expect((await findMatchById(match.id))!.status).toBe('awaiting_results');
    expect(await reconcileWallets()).toEqual([]);
  });

  it('settles a held match once the missing screenshot finally arrives', async () => {
    const creator = await makeUser({ balanceCents: 5000, trustScore: 60, psnId: 'Striker_Sam' });
    const opponent = await makeUser({ balanceCents: 5000, trustScore: 62, psnId: 'KeeperKate' });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);

    // Both agree, but neither has uploaded anything yet: escrow is held.
    await submitResult(creator, { matchId: match.id, selfScore: 3, opponentScore: 1 });
    const held = await submitResult(opponent, { matchId: match.id, selfScore: 1, opponentScore: 3 });
    expect(held.status).toBe('held_for_review');

    await uploadScreenshot(creator, {
      matchId: match.id,
      contentType: 'image/png',
      dataBase64: upload(scoreboardImage(96, 64, 41), FUT_SCREEN),
    });
    await drainOcrQueue();
    // One screenshot is not enough — the other player still owes theirs.
    expect(await accountBalance(matchEscrow(match.id))).toBe(2000);

    await uploadScreenshot(opponent, {
      matchId: match.id,
      contentType: 'image/png',
      dataBase64: upload(scoreboardImage(96, 64, 42), FUT_SCREEN),
    });
    await drainOcrQueue();

    // With the evidence complete, the settlement that was waiting goes through
    // on its own — no second report, no moderator, no stuck escrow.
    const settled = await findMatchById(match.id);
    expect(settled!.status).toBe('settled');
    expect(settled!.winnerId).toBe(creator.id);
    expect(await accountBalance(matchEscrow(match.id))).toBe(0);
    expect((await getWallet(creator.id))!.availableCents).toBe(4000 + 1800);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('escalates a match still missing evidence when the window closes', async () => {
    const creator = await makeUser({ balanceCents: 5000, trustScore: 60, psnId: 'Striker_Sam' });
    const opponent = await makeUser({ balanceCents: 5000, trustScore: 62, psnId: 'KeeperKate' });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);

    await submitResult(creator, { matchId: match.id, selfScore: 2, opponentScore: 0 });
    await submitResult(opponent, { matchId: match.id, selfScore: 0, opponentScore: 2 });
    await updateMatch(match.id, { reportDeadlineAt: new Date(Date.now() - 60_000).toISOString() });

    const escalated = await sweepLapsedMatches();

    // The escrow must never simply sit there: a human picks it up instead.
    expect(escalated).toContain(match.id);
    expect((await findMatchById(match.id))!.status).toBe('disputed');
    expect(await accountBalance(matchEscrow(match.id))).toBe(2000);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('will not auto-settle over a screenshot that failed verification', async () => {
    const first = await playersAndMatch();
    const image = scoreboardImage(96, 64, 11);
    await uploadScreenshot(first.creator, {
      matchId: first.match.id,
      contentType: 'image/png',
      dataBase64: upload(image, FUT_SCREEN),
    });
    await drainOcrQueue();

    const second = await createMatch(first.creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(first.opponent, second.id);
    const reused = await uploadScreenshot(first.creator, {
      matchId: second.id,
      contentType: 'image/png',
      dataBase64: upload(image, FUT_SCREEN),
    });
    await drainOcrQueue();
    expect((await findScreenshotById(reused.id))!.verdict).toBe('duplicate');

    await submitResult(first.creator, {
      matchId: second.id,
      selfScore: 3,
      opponentScore: 1,
      screenshotId: reused.id,
    });
    const outcome = await submitResult(first.opponent, {
      matchId: second.id,
      selfScore: 1,
      opponentScore: 3,
    });

    // The two players agree — but the evidence is recycled, so a human rules.
    expect(outcome.status).toBe('disputed');
    expect(await accountBalance(matchEscrow(second.id))).toBe(2000);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('refuses a screenshot belonging to someone else’s match', async () => {
    const a = await playersAndMatch();
    const b = await playersAndMatch();
    const screenshot = await uploadScreenshot(a.creator, {
      matchId: a.match.id,
      contentType: 'image/png',
      dataBase64: upload(scoreboardImage(), FUT_SCREEN),
    });

    await expect(
      submitResult(b.creator, {
        matchId: b.match.id,
        selfScore: 1,
        opponentScore: 0,
        screenshotId: screenshot.id,
      }),
    ).rejects.toMatchObject({ code: 'screenshot_mismatch' });
    expect(await listScreenshotsForMatch(b.match.id)).toHaveLength(0);
  });
});
