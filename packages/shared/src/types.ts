// ---------------------------------------------------------------------------
// Goal 27 — shared domain types.
//
// Money is ALWAYS integer cents. Never a float, never a string, anywhere.
// ---------------------------------------------------------------------------

export type UserRole = 'player' | 'moderator' | 'admin';

export type KycStatus = 'unstarted' | 'pending' | 'approved' | 'rejected';

export type SubscriptionTier = 'free' | 'pro';

export type SkillTier = 'rookie' | 'amateur' | 'semi_pro' | 'pro' | 'elite';

export const SKILL_TIERS: readonly SkillTier[] = [
  'rookie',
  'amateur',
  'semi_pro',
  'pro',
  'elite',
] as const;

/** EA Sports FC game modes a money match can be played in. */
export type GameMode = 'ultimate_team' | 'seasons' | 'clubs' | 'pro_clubs';

export const GAME_MODES: readonly GameMode[] = [
  'ultimate_team',
  'seasons',
  'clubs',
  'pro_clubs',
] as const;

export type MatchStatus =
  | 'open' // created, waiting for an opponent to join and escrow
  | 'escrowed' // both stakes locked, players in the match room
  | 'in_progress' // both players readied up, clock running
  | 'awaiting_results' // played, waiting on result submissions
  | 'disputed' // submissions conflict or a report deadline lapsed
  | 'settled' // winner paid
  | 'voided' // draw or mutual cancel — stakes returned in full, no rake
  | 'cancelled'; // never fully escrowed

export type EscrowStatus = 'pending' | 'funded' | 'released' | 'refunded';

export type LedgerTransactionType =
  | 'deposit'
  | 'withdrawal'
  | 'escrow_lock'
  | 'escrow_payout'
  | 'platform_rake'
  | 'refund'
  | 'tournament_entry'
  | 'tournament_prize'
  | 'adjustment';

export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'auto_resolved';

export type DisputeResolution =
  | 'creator_wins'
  | 'opponent_wins'
  | 'void_refund'
  | 'replay'
  | 'dismissed';

export type MatchOutcome = 'creator_win' | 'opponent_win' | 'draw';

export type TrustEventType =
  | 'match_settled_clean'
  | 'report_accurate'
  | 'report_inaccurate'
  | 'dispute_raised'
  | 'dispute_lost'
  | 'dispute_won'
  | 'report_timeout'
  | 'match_cancelled'
  | 'strike'
  | 'manual_adjustment';

export type NotificationType =
  | 'match_joined'
  | 'match_ready'
  | 'result_submitted'
  | 'match_settled'
  | 'dispute_opened'
  | 'dispute_resolved'
  | 'wallet_credited'
  | 'wallet_debited'
  | 'kyc_updated'
  | 'tournament_started';

export type TournamentStatus = 'registering' | 'running' | 'completed' | 'cancelled';

export type ScreenshotVerdict =
  | 'pending' // queued for OCR
  | 'match' // OCR agrees with the typed scoreline
  | 'mismatch' // OCR read a different scoreline than the player typed
  | 'unreadable' // OCR could not find a scoreline
  | 'duplicate'; // perceptually identical to a screenshot already on file

// ---------------------------------------------------------------------------

export interface MatchRules {
  /** Minutes per half, as configured in the FIFA match lobby. */
  halfLengthMinutes: number;
  customTactics: boolean;
  chemistryStyles: boolean;
  /** Ultimate Team squad rating cap; null means no restriction. */
  squadRatingCap: number | null;
  extraTimeAndPenalties: boolean;
  notes: string | null;
}

export interface PublicUser {
  id: string;
  handle: string;
  psnId: string | null;
  skillTier: SkillTier;
  trustScore: number;
  wins: number;
  losses: number;
  draws: number;
  subscriptionTier: SubscriptionTier;
  createdAt: string;
}

export interface SelfUser extends PublicUser {
  email: string;
  phone: string | null;
  role: UserRole;
  kycStatus: KycStatus;
  emailVerified: boolean;
  phoneVerified: boolean;
  countryCode: string | null;
  dateOfBirth: string | null;
  selfExcludedUntil: string | null;
  strikes: number;
  bannedAt: string | null;
}

export interface Wallet {
  userId: string;
  availableCents: number;
  /** Sum of stakes currently sitting in escrow across live matches. */
  lockedCents: number;
  currency: 'USD';
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  transactionId: string;
  debitAccount: string;
  creditAccount: string;
  amountCents: number;
  createdAt: string;
}

export interface LedgerTransaction {
  id: string;
  type: LedgerTransactionType;
  userId: string | null;
  matchId: string | null;
  memo: string | null;
  createdAt: string;
  entries: LedgerEntry[];
}

export interface Match {
  id: string;
  creatorId: string;
  opponentId: string | null;
  game: string;
  gameMode: GameMode;
  stakeCents: number;
  rakeBps: number;
  rules: MatchRules;
  status: MatchStatus;
  escrowStatus: EscrowStatus;
  winnerId: string | null;
  outcome: MatchOutcome | null;
  /** Final scoreline, from the creator's point of view. */
  creatorScore: number | null;
  opponentScore: number | null;
  creatorReady: boolean;
  opponentReady: boolean;
  startedAt: string | null;
  /** Results submitted after this instant are late; the match auto-disputes. */
  reportDeadlineAt: string | null;
  settledAt: string | null;
  createdAt: string;
}

export interface MatchResult {
  id: string;
  matchId: string;
  reporterId: string;
  /** Goals scored by the reporter, and by their opponent. */
  selfScore: number;
  opponentScore: number;
  screenshotId: string | null;
  clipUrl: string | null;
  createdAt: string;
}

export interface Screenshot {
  id: string;
  matchId: string;
  uploaderId: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  /** SHA-256 of the raw bytes — the immutability seal. */
  sha256: string;
  /** 64-bit dHash as 16 hex chars; null until the OCR worker processes it. */
  perceptualHash: string | null;
  ocrText: string | null;
  ocrHomeTag: string | null;
  ocrAwayTag: string | null;
  ocrHomeScore: number | null;
  ocrAwayScore: number | null;
  verdict: ScreenshotVerdict;
  /** Screenshot this one duplicates, when verdict is `duplicate`. */
  duplicateOfId: string | null;
  capturedAt: string | null;
  createdAt: string;
}

export interface Dispute {
  id: string;
  matchId: string;
  raisedBy: string | null; // null when the system auto-escalated
  reason: string;
  status: DisputeStatus;
  resolution: DisputeResolution | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TrustEvent {
  id: string;
  userId: string;
  type: TrustEventType;
  matchId: string | null;
  delta: number;
  note: string | null;
  createdAt: string;
}

export interface KycRecord {
  id: string;
  userId: string;
  status: KycStatus;
  documentType: string;
  documentRef: string;
  selfieRef: string;
  addressCountry: string;
  addressRegion: string | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  matchId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface Tournament {
  id: string;
  name: string;
  gameMode: GameMode;
  entryFeeCents: number;
  rakeBps: number;
  maxEntrants: number;
  status: TournamentStatus;
  rules: MatchRules;
  sponsorName: string | null;
  startsAt: string | null;
  createdAt: string;
}

export interface TournamentEntry {
  id: string;
  tournamentId: string;
  userId: string;
  seed: number | null;
  eliminatedInRound: number | null;
  placement: number | null;
  createdAt: string;
}

export interface BracketSlot {
  round: number;
  position: number;
  matchId: string | null;
  playerAId: string | null;
  playerBId: string | null;
  winnerId: string | null;
}

export interface ChatMessage {
  id: string;
  matchId: string;
  userId: string;
  handle: string;
  body: string;
  createdAt: string;
}

export interface LeaderboardRow {
  userId: string;
  handle: string;
  psnId: string | null;
  stakeTierCents: number;
  wins: number;
  losses: number;
  netCents: number;
  trustScore: number;
}
