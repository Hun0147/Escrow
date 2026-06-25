import { calculateSettlement } from '@escrow/shared';
import { store } from '../../db/store';
import { createMatch, fundEscrow } from '../matches/matches.service';
import { settleMatch, SettlementError } from './settlement.service';
import { deposit } from '../wallet/wallet.service';

function makeUser(id: string) {
  store.users.set(id, {
    id,
    email: `${id}@example.com`,
    passwordHash: 'x',
    psnId: null,
    walletBalanceCents: 0,
    kycStatus: 'approved',
    createdAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  store.users.clear();
  store.matches.clear();
  store.escrows.clear();
  store.transactions.clear();
  store.disputes.clear();
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

describe('settleMatch end-to-end', () => {
  it('pays the winner the pool minus 12% and zeroes out the escrow', () => {
    makeUser('11111111-1111-1111-1111-111111111111');
    makeUser('22222222-2222-2222-2222-222222222222');
    const creator = '11111111-1111-1111-1111-111111111111';
    const opponent = '22222222-2222-2222-2222-222222222222';

    deposit(creator, 10000);
    deposit(opponent, 10000);

    const match = createMatch(creator, 'EA Sports FC 26', 10000);
    fundEscrow(match.id, creator);
    fundEscrow(match.id, opponent);

    const result = settleMatch(match.id, creator);

    expect(result.payoutCents).toBe(17600);
    expect(result.platformFeeCents).toBe(2400);
    expect(store.users.get(creator)!.walletBalanceCents).toBe(17600);
    expect(store.matches.get(match.id)!.status).toBe('settled');
    expect(store.escrowByMatchId(match.id)!.status).toBe('released');
  });

  it('refuses to settle an unfunded match', () => {
    makeUser('33333333-3333-3333-3333-333333333333');
    const creator = '33333333-3333-3333-3333-333333333333';
    const match = createMatch(creator, 'NBA 2K', 5000);
    expect(() => settleMatch(match.id, creator)).toThrow(SettlementError);
  });
});
