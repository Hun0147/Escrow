import { Dispute, Escrow, Match, Transaction, User } from '@escrow/shared';

/**
 * In-memory persistence for the MVP. Swap for Postgres (see schema.sql) once
 * real money movement is wired to a payment provider.
 */
export class Store {
  users = new Map<string, User & { passwordHash: string }>();
  matches = new Map<string, Match>();
  escrows = new Map<string, Escrow>();
  transactions = new Map<string, Transaction>();
  disputes = new Map<string, Dispute>();

  findUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email);
  }

  escrowByMatchId(matchId: string) {
    return [...this.escrows.values()].find((e) => e.matchId === matchId);
  }
}

export const store = new Store();
