import { GameMode, MatchRules } from './types';

export const DEFAULT_MATCH_RULES: MatchRules = {
  halfLengthMinutes: 6,
  customTactics: true,
  chemistryStyles: false,
  squadRatingCap: null,
  extraTimeAndPenalties: false,
  notes: null,
};

export const ALLOWED_HALF_LENGTHS = [4, 5, 6, 8, 10, 12] as const;

export const GAME_MODE_LABELS: Record<GameMode, string> = {
  ultimate_team: 'Ultimate Team',
  seasons: 'Seasons',
  clubs: 'Clubs',
  pro_clubs: 'Pro Clubs',
};

export function normaliseRules(input: Partial<MatchRules> | null | undefined): MatchRules {
  const rules: MatchRules = { ...DEFAULT_MATCH_RULES, ...(input ?? {}) };
  if (!(ALLOWED_HALF_LENGTHS as readonly number[]).includes(rules.halfLengthMinutes)) {
    throw new Error(`Half length must be one of ${ALLOWED_HALF_LENGTHS.join(', ')} minutes`);
  }
  if (
    rules.squadRatingCap !== null &&
    (!Number.isInteger(rules.squadRatingCap) || rules.squadRatingCap < 60 || rules.squadRatingCap > 99)
  ) {
    throw new Error('Squad rating cap must be an integer between 60 and 99, or null');
  }
  if (rules.notes !== null && rules.notes.length > 280) {
    throw new Error('Rule notes must be 280 characters or fewer');
  }
  return rules;
}

/** One-line summary of the rules, restated in the match room and on the card. */
export function describeRules(rules: MatchRules): string {
  const parts = [`${rules.halfLengthMinutes} min halves`];
  parts.push(rules.customTactics ? 'custom tactics on' : 'no custom tactics');
  parts.push(rules.chemistryStyles ? 'chem styles on' : 'no chem styles');
  if (rules.squadRatingCap !== null) parts.push(`${rules.squadRatingCap} squad cap`);
  parts.push(rules.extraTimeAndPenalties ? 'ET + pens' : 'no ET');
  return parts.join(' · ');
}
