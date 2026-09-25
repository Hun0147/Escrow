import { LedgerTransaction, LedgerTransactionType, Wallet } from '@escrow/shared';
import { pool } from '../pool';
import { Queryable } from './users.repo';

export interface EntryInput {
  debitAccount: string;
  creditAccount: string;
  amountCents: number;
}

export interface PostTransactionParams {
  type: LedgerTransactionType;
  userId?: string | null;
  matchId?: string | null;
  tournamentId?: string | null;
  memo?: string | null;
  entries: EntryInput[];
}

/**
 * Writes one journal transaction and its entries.
 *
 * Callers must pass a client inside an open transaction: a ledger write is
 * only ever correct alongside the wallet-cache update it pairs with.
 */
export async function postTransaction(
  params: PostTransactionParams,
  db: Queryable,
): Promise<LedgerTransaction> {
  if (params.entries.length === 0) {
    throw new Error('A ledger transaction needs at least one entry');
  }
  for (const entry of params.entries) {
    if (!Number.isInteger(entry.amountCents) || entry.amountCents <= 0) {
      throw new Error('Ledger amounts must be positive integer cents');
    }
    if (entry.debitAccount === entry.creditAccount) {
      throw new Error('Ledger entry cannot debit and credit the same account');
    }
  }

  const { rows } = await db.query(
    `INSERT INTO ledger_transactions (type, user_id, match_id, tournament_id, memo)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [params.type, params.userId ?? null, params.matchId ?? null, params.tournamentId ?? null, params.memo ?? null],
  );
  const transactionRow = rows[0];

  const entryRows = [];
  for (const entry of params.entries) {
    const inserted = await db.query(
      `INSERT INTO ledger_entries (transaction_id, debit_account, credit_account, amount_cents)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [transactionRow.id, entry.debitAccount, entry.creditAccount, entry.amountCents],
    );
    entryRows.push(inserted.rows[0]);
  }

  return {
    id: transactionRow.id,
    type: transactionRow.type,
    userId: transactionRow.user_id,
    matchId: transactionRow.match_id,
    memo: transactionRow.memo,
    createdAt: transactionRow.created_at.toISOString(),
    entries: entryRows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      debitAccount: row.debit_account,
      creditAccount: row.credit_account,
      amountCents: Number(row.amount_cents),
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export async function accountBalance(account: string, db: Queryable = pool): Promise<number> {
  const { rows } = await db.query(
    'SELECT COALESCE(balance_cents, 0) AS balance_cents FROM v_ledger_balances WHERE account = $1',
    [account],
  );
  return rows[0] ? Number(rows[0].balance_cents) : 0;
}

export interface LedgerHistoryRow {
  transactionId: string;
  type: LedgerTransactionType;
  matchId: string | null;
  memo: string | null;
  /** Signed against the requested account: positive is money in. */
  deltaCents: number;
  createdAt: string;
}

export async function accountHistory(
  account: string,
  limit = 50,
  db: Queryable = pool,
): Promise<LedgerHistoryRow[]> {
  const { rows } = await db.query(
    `SELECT t.id, t.type, t.match_id, t.memo, e.created_at,
            CASE WHEN e.credit_account = $1 THEN e.amount_cents ELSE -e.amount_cents END AS delta
     FROM ledger_entries e
     JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE e.credit_account = $1 OR e.debit_account = $1
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT $2`,
    [account, limit],
  );
  return rows.map((row) => ({
    transactionId: row.id,
    type: row.type,
    matchId: row.match_id,
    memo: row.memo,
    deltaCents: Number(row.delta),
    createdAt: row.created_at.toISOString(),
  }));
}

// ------------------------------------------------------------------ wallets

function mapWallet(row: any): Wallet {
  return {
    userId: row.user_id,
    availableCents: Number(row.available_cents),
    lockedCents: Number(row.locked_cents),
    currency: row.currency,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function createWallet(userId: string, db: Queryable = pool): Promise<Wallet> {
  const { rows } = await db.query(
    'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING *',
    [userId],
  );
  if (rows[0]) return mapWallet(rows[0]);
  return (await getWallet(userId, db))!;
}

export async function getWallet(userId: string, db: Queryable = pool): Promise<Wallet | null> {
  const { rows } = await db.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  return rows[0] ? mapWallet(rows[0]) : null;
}

export async function lockWallet(userId: string, db: Queryable): Promise<Wallet> {
  const { rows } = await db.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  if (!rows[0]) throw new Error(`Wallet missing for user ${userId}`);
  return mapWallet(rows[0]);
}

export class InsufficientFundsError extends Error {}

/**
 * Adjusts the materialised wallet balances.
 *
 * The non-negative invariant is enforced by the WHERE clause (and, as a
 * backstop, by CHECK constraints), so two concurrent stakes can never both
 * pass a read-then-write balance check and overdraw the account.
 */
export async function adjustWallet(
  userId: string,
  deltas: { availableCents?: number; lockedCents?: number },
  db: Queryable,
): Promise<Wallet> {
  const available = deltas.availableCents ?? 0;
  const locked = deltas.lockedCents ?? 0;
  const { rows } = await db.query(
    `UPDATE wallets
     SET available_cents = available_cents + $2,
         locked_cents = locked_cents + $3,
         updated_at = now()
     WHERE user_id = $1
       AND available_cents + $2 >= 0
       AND locked_cents + $3 >= 0
     RETURNING *`,
    [userId, available, locked],
  );
  if (!rows[0]) throw new InsufficientFundsError('Insufficient wallet balance');
  return mapWallet(rows[0]);
}

/**
 * Reconciliation.
 *
 * Two invariants must hold for every user at rest:
 *   available_cents == the ledger balance of `user:<id>:available`
 *   locked_cents    == their stake in every match whose escrow is still funded
 *
 * Any row returned here is a bug in a money path, not a data-entry problem.
 */
export interface ReconciliationDiff {
  userId: string;
  field: 'available' | 'locked';
  walletCents: number;
  expectedCents: number;
}

export async function reconcileWallets(db: Queryable = pool): Promise<ReconciliationDiff[]> {
  const { rows } = await db.query(`
    WITH ledger_available AS (
      SELECT (split_part(account, ':', 2))::uuid AS user_id, balance_cents
      FROM v_ledger_balances
      WHERE account LIKE 'user:%:available'
    ),
    match_locked AS (
      -- With escrow 'pending' only the creator has staked; once it is 'funded'
      -- both players have.
      SELECT u.id AS user_id,
             COALESCE(SUM(CASE
               WHEN m.escrow_status = 'funded' AND (m.creator_id = u.id OR m.opponent_id = u.id)
                 THEN m.stake_cents
               WHEN m.escrow_status = 'pending' AND m.creator_id = u.id
                 THEN m.stake_cents
               ELSE 0
             END), 0) AS locked_cents
      FROM users u
      LEFT JOIN matches m ON m.creator_id = u.id OR m.opponent_id = u.id
      GROUP BY u.id
    ),
    tournament_locked AS (
      SELECT te.user_id, COALESCE(SUM(t.entry_fee_cents), 0) AS locked_cents
      FROM tournament_entries te
      JOIN tournaments t ON t.id = te.tournament_id
      WHERE t.status IN ('registering', 'running')
      GROUP BY te.user_id
    ),
    expected_locked AS (
      SELECT ml.user_id, ml.locked_cents + COALESCE(tl.locked_cents, 0) AS locked_cents
      FROM match_locked ml
      LEFT JOIN tournament_locked tl ON tl.user_id = ml.user_id
    )
    SELECT w.user_id, 'available' AS field, w.available_cents AS wallet_cents,
           COALESCE(la.balance_cents, 0) AS expected_cents
    FROM wallets w
    LEFT JOIN ledger_available la ON la.user_id = w.user_id
    WHERE w.available_cents <> COALESCE(la.balance_cents, 0)
    UNION ALL
    SELECT w.user_id, 'locked' AS field, w.locked_cents AS wallet_cents,
           COALESCE(el.locked_cents, 0) AS expected_cents
    FROM wallets w
    LEFT JOIN expected_locked el ON el.user_id = w.user_id
    WHERE w.locked_cents <> COALESCE(el.locked_cents, 0)
  `);
  return rows.map((row) => ({
    userId: row.user_id,
    field: row.field,
    walletCents: Number(row.wallet_cents),
    expectedCents: Number(row.expected_cents),
  }));
}
