export type KycStatus = 'pending' | 'approved' | 'rejected';
export type MatchStatus = 'created' | 'funded' | 'in_progress' | 'awaiting_confirmation' | 'disputed' | 'settled' | 'cancelled';
export type EscrowStatus = 'pending' | 'funded' | 'released' | 'refunded';
export type TransactionType = 'deposit' | 'withdrawal' | 'escrow_lock' | 'escrow_release' | 'platform_fee' | 'refund';
export type TransactionStatus = 'pending' | 'completed' | 'failed';
export type DisputeStatus = 'open' | 'community_review' | 'moderator_review' | 'arbitration' | 'resolved';

export interface User {
  id: string;
  email: string;
  psnId: string | null;
  walletBalanceCents: number;
  kycStatus: KycStatus;
  createdAt: string;
}

export interface Match {
  id: string;
  creatorId: string;
  opponentId: string | null;
  game: string;
  stakeCents: number;
  status: MatchStatus;
  winnerId: string | null;
  createdAt: string;
}

export interface Escrow {
  id: string;
  matchId: string;
  amountCents: number;
  status: EscrowStatus;
  releasedAt: string | null;
}

export interface Transaction {
  id: string;
  userId: string;
  type: TransactionType;
  amountCents: number;
  status: TransactionStatus;
  createdAt: string;
}

export interface Dispute {
  id: string;
  matchId: string;
  raisedBy: string;
  status: DisputeStatus;
  evidence: string[];
  createdAt: string;
}
