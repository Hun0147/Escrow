import { calculateSettlement } from '@escrow/shared';
import { pool } from '../../db/pool';
import { createUser } from '../../db/users.repo';
import { createMatch, fundEscrow } from '../matches/matches.service';
import { settleMatch, SettlementError } from './settlement.service';
import { findUserById } from '../../db/users.repo';
import { findMatchById } from '../../db/matches.repo';
import { findEscrowByMatchId } from '../../db/escrows.repo';
import { deposit } from '../wallet/wallet.service';

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE disputes, transactions, escrows, matches, users CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('calculateSettlement', () => {
  it('takes exactly 12% of the pool as the platform fee', () => {
    const result = calculateSettlement(10000, 10000); // $100 + $100
    expect(result.grossPoolCents).toBe(20000);
    expect(result.platformFeeCents).toBe(2400); // $24
    expect(result.payoutCents).toBe(17600); // $176
  });

  it('rejects mismatched stakes', () => {
    expect(() => calculateSettlement(10000, 9000)).toThrow();
  });

  it('rejects non-positive stakes', () => {
    expect(() => calculateSettlement(0, 0)).toThrow();
  });
});

describe('settleMatch end-to-end (against real Postgres)', () => {
  it('pays the winner the pool minus 12% and zeroes out the escrow', async () => {
    const creator = await createUser({ email: 'creator@example.com', passwordHash: 'x' });
    const opponent = await createUser({ email: 'opponent@example.com', passwordHash: 'x' });

    await deposit(creator.id, 10000);
    await deposit(opponent.id, 10000);

    const match = await createMatch(creator.id, 'EA Sports FC 26', 10000);
    await fundEscrow(match.id, creator.id);
    await fundEscrow(match.id, opponent.id);

    const result = await settleMatch(match.id, creator.id);

    expect(result.payoutCents).toBe(17600);
    expect(result.platformFeeCents).toBe(2400);
    expect((await findUserById(creator.id))!.walletBalanceCents).toBe(17600);
    expect((await findMatchById(match.id))!.status).toBe('settled');
    expect((await findEscrowByMatchId(match.id))!.status).toBe('released');
  });

  it('refuses to settle an unfunded match', async () => {
    const creator = await createUser({ email: 'solo@example.com', passwordHash: 'x' });
    const match = await createMatch(creator.id, 'NBA 2K', 5000);
    await expect(settleMatch(match.id, creator.id)).rejects.toThrow(SettlementError);
  });
});
