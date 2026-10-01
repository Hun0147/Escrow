/**
 * Parsing an EA Sports FC post-match summary out of raw OCR text.
 *
 * The OCR engine itself is swappable (see the API's ocr module); everything
 * that decides whether a screenshot backs up a player's typed result lives
 * here, as pure functions, so it can be tested against real-world OCR noise
 * without running an OCR engine.
 */

export interface ParsedScoreboard {
  homeTag: string | null;
  awayTag: string | null;
  homeScore: number | null;
  awayScore: number | null;
  /** 0-1. Below ~0.5 the read is too weak to auto-settle on. */
  confidence: number;
}

/** PSN online IDs: 3-16 chars, letters/digits/hyphen/underscore, must start alphanumeric. */
const PSN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,15}$/;

/** `3-1`, `3 - 1`, `3 : 1`, `3 – 1` (en dash), `3 —1`. */
const SCORE_SEPARATOR = /(\d{1,2})\s*[-–—:]\s*(\d{1,2})/;

const NOISE_WORDS = new Set([
  'FULL', 'TIME', 'FULLTIME', 'HALF', 'MATCH', 'FACTS', 'SUMMARY', 'POSSESSION',
  'SHOTS', 'TARGET', 'ON', 'PASSES', 'PASS', 'ACCURACY', 'FOULS', 'OFFSIDES',
  'CORNERS', 'YELLOW', 'RED', 'CARDS', 'SAVES', 'TACKLES', 'RATING', 'EXTRA',
  'PENALTIES', 'AET', 'PENS', 'HOME', 'AWAY', 'VS', 'CONTINUE', 'FT', 'GOALS',
  'SQUAD', 'DIVISION', 'WEEKEND', 'LEAGUE', 'RIVALS', 'CHAMPIONS',
]);

export function parseScoreboard(rawText: string): ParsedScoreboard {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const empty: ParsedScoreboard = {
    homeTag: null,
    awayTag: null,
    homeScore: null,
    awayScore: null,
    confidence: 0,
  };
  if (lines.length === 0) return empty;

  for (let i = 0; i < lines.length; i++) {
    const match = SCORE_SEPARATOR.exec(lines[i]);
    if (!match) continue;

    const homeScore = Number(match[1]);
    const awayScore = Number(match[2]);
    if (homeScore > 30 || awayScore > 30) continue; // a clock or a date, not a scoreline

    // Tags on the same line as the score are the strongest signal.
    const before = lines[i].slice(0, match.index);
    const after = lines[i].slice(match.index + match[0].length);
    let homeTag = lastGamertag(before);
    let awayTag = firstGamertag(after);

    // Otherwise the layout stacks them: tag, score, tag on separate lines.
    if (!homeTag) homeTag = searchGamertag(lines, i - 1, -1);
    if (!awayTag) awayTag = searchGamertag(lines, i + 1, 1);

    let confidence = 0.5; // a plausible scoreline on its own
    if (homeTag) confidence += 0.2;
    if (awayTag) confidence += 0.2;
    if (lines.some((line) => /FULL\s*TIME|^FT$/i.test(line))) confidence += 0.1;

    return {
      homeTag,
      awayTag,
      homeScore,
      awayScore,
      confidence: Math.min(1, Number(confidence.toFixed(2))),
    };
  }

  return empty;
}

function candidateTokens(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9_-]+/)
    .filter((token) => PSN_ID.test(token) && !NOISE_WORDS.has(token.toUpperCase()) && !/^\d+$/.test(token));
}

function firstGamertag(text: string): string | null {
  return candidateTokens(text)[0] ?? null;
}

function lastGamertag(text: string): string | null {
  const tokens = candidateTokens(text);
  return tokens.length ? tokens[tokens.length - 1] : null;
}

/** Walks outward from the score line looking for the nearest plausible tag. */
function searchGamertag(lines: string[], start: number, step: number): string | null {
  for (let i = start; i >= 0 && i < lines.length && Math.abs(i - start) < 3; i += step) {
    const tag = firstGamertag(lines[i]);
    if (tag) return tag;
  }
  return null;
}

export interface OcrComparison {
  /** OCR read a scoreline confidently enough to be worth trusting at all. */
  readable: boolean;
  /** The OCR scoreline equals the typed scoreline (in either orientation). */
  scoreMatches: boolean;
  /** Both expected gamertags appear in the OCR output. */
  gamertagsMatch: boolean;
  flags: string[];
}

export const MIN_OCR_CONFIDENCE = 0.5;

/**
 * Checks a parsed scoreboard against what the player typed.
 *
 * Orientation is unknown — we can't tell from the pixels which side of the
 * screen the reporter was on — so a score matches if it agrees either way
 * round. That is deliberately lenient: this check exists to catch a fabricated
 * or recycled screenshot, not to referee which player was "home".
 */
export function compareOcrToReport(
  parsed: ParsedScoreboard,
  typed: { selfScore: number; opponentScore: number },
  expectedTags: { reporterPsnId: string | null; opponentPsnId: string | null },
): OcrComparison {
  const flags: string[] = [];
  const readable =
    parsed.homeScore !== null && parsed.awayScore !== null && parsed.confidence >= MIN_OCR_CONFIDENCE;

  if (!readable) {
    flags.push('ocr_unreadable');
    return { readable: false, scoreMatches: false, gamertagsMatch: false, flags };
  }

  const scoreMatches =
    (parsed.homeScore === typed.selfScore && parsed.awayScore === typed.opponentScore) ||
    (parsed.homeScore === typed.opponentScore && parsed.awayScore === typed.selfScore);
  if (!scoreMatches) flags.push('score_mismatch');

  const seen = [parsed.homeTag, parsed.awayTag]
    .filter((tag): tag is string => Boolean(tag))
    .map((tag) => tag.toLowerCase());
  const expected = [expectedTags.reporterPsnId, expectedTags.opponentPsnId]
    .filter((tag): tag is string => Boolean(tag))
    .map((tag) => tag.toLowerCase());

  const gamertagsMatch = expected.length > 0 && expected.every((tag) => seen.includes(tag));
  if (expected.length > 0 && !gamertagsMatch) flags.push('gamertag_mismatch');

  return { readable, scoreMatches, gamertagsMatch, flags };
}
