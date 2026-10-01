import { EXTERNAL_SETTLEMENT, PLATFORM_REVENUE, matchEscrow, userAvailable } from '@escrow/shared';
import { pool } from '../src/db/pool';
import { fund, makeUser, ULTIMATE_TEAM } from './factories';
import { accountBalance, accountHistory, postTransaction, reconcileWallets } from '../src/db/repos/ledger.repo';
import { withTransaction } from '../src/db/transaction';
import { createMatch, joinMatch } from '../src/modules/matches/matches.service';
import { submitResult } from '../src/modules/results/results.service';

describe('double-entry ledger', () => {
  it('is append-only: history cannot be edited or erased', async () => {
    const user = await makeUser({ balanceCents: 1000 });
    const { rows } = await pool.query('SELECT id FROM ledger_entries LIMIT 1');
    const entryId = rows[0].id;

    await expect(
      pool.query('UPDATE ledger_entries SET amount_cents = 1 WHERE id = $1', [entryId]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM ledger_entries WHERE id = $1', [entryId])).rejects.toThrow(
      /append-only/,
    );
    await expect(
      pool.query('DELETE FROM ledger_transactions WHERE id = (SELECT transaction_id FROM ledger_entries LIMIT 1)'),
    ).rejects.toThrow(/append-only/);
    expect(user.id).toBeTruthy();
  });

  it('rejects a one-sided or self-referential entry', async () => {
    const user = await makeUser();
    await expect(
      withTransaction((client) =>
        postTransaction(
          {
            type: 'adjustment',
            entries: [
              { debitAccount: userAvailable(user.id), creditAccount: userAvailable(user.id), amountCents: 100 },
            ],
          },
          client,
        ),
      ),
    ).rejects.toThrow(/same account/);

    await expect(
      withTransaction((client) =>
        postTransaction(
          {
            type: 'adjustment',
            entries: [
              { debitAccount: EXTERNAL_SETTLEMENT, creditAccount: userAvailable(user.id), amountCents: -5 },
            ],
          },
          client,
        ),
      ),
    ).rejects.toThrow(/positive integer cents/);
  });

  it('sums to zero across all accounts after a full match lifecycle', async () => {
    const creator = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const opponent = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 });
    await joinMatch(opponent, match.id);
    await submitResult(creator, { matchId: match.id, selfScore: 2, opponentScore: 0 });
    await submitResult(opponent, { matchId: match.id, selfScore: 0, opponentScore: 2 });

    const { rows } = await pool.query('SELECT SUM(balance_cents) AS total FROM v_ledger_balances');
    // Money is conserved: what the players and the house hold is exactly what
    // came in through the external settlement account.
    expect(Number(rows[0].total)).toBe(0);

    expect(await accountBalance(EXTERNAL_SETTLEMENT)).toBe(-10000);
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(500);
    expect(await accountBalance(matchEscrow(match.id))).toBe(0);
    expect(
      (await accountBalance(userAvailable(creator.id))) + (await accountBalance(userAvailable(opponent.id))),
    ).toBe(9500);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('records a readable, signed statement for the player', async () => {
    const creator = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const opponent = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);
    await submitResult(creator, { matchId: match.id, selfScore: 1, opponentScore: 0 });
    await submitResult(opponent, { matchId: match.id, selfScore: 0, opponentScore: 1 });

    const history = await accountHistory(userAvailable(creator.id));
    const types = history.map((entry) => entry.type);
    expect(types).toContain('deposit');
    expect(types).toContain('escrow_lock');
    expect(types).toContain('escrow_payout');

    expect(history.find((e) => e.type === 'escrow_lock')!.deltaCents).toBe(-1000);
    expect(history.find((e) => e.type === 'escrow_payout')!.deltaCents).toBe(1800);
    // The statement's running total is the wallet balance.
    expect(history.reduce((sum, entry) => sum + entry.deltaCents, 0)).toBe(
      await accountBalance(userAvailable(creator.id)),
    );
  });

  it('never lets a wallet go negative, even under concurrent stakes', async () => {
    const player = await makeUser({ balanceCents: 2500 });
    const outcomes = await Promise.allSettled([
      createMatch(player, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 }),
      createMatch(player, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 }),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await accountBalance(userAvailable(player.id))).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('keeps deposits additive and traceable', async () => {
    const player = await makeUser();
    await fund(player.id, 1000);
    await fund(player.id, 250);
    expect(await accountBalance(userAvailable(player.id))).toBe(1250);
    expect(await reconcileWallets()).toEqual([]);
  });
});
