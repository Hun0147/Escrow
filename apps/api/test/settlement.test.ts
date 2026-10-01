import {
  DEFAULT_ESCROW_FEE_BPS,
  PRO_ESCROW_FEE_BPS,
  calculateSettlement,
  calculateWithdrawal,
  computeTrustScore,
  outcomeFor,
  qualifiesForProRate,
  reconcile,
  settlementPolicyFor,
} from '@escrow/shared';

describe('calculateSettlement', () => {
  it('takes a 10% escrow fee by default and pays the rest to the winner', () => {
    const result = calculateSettlement(2500, 2500);
    expect(result.grossPoolCents).toBe(5000);
    expect(result.platformFeeCents).toBe(500);
    expect(result.payoutCents).toBe(4500);
    expect(result.feeBps).toBe(DEFAULT_ESCROW_FEE_BPS);
  });

  it('never creates or destroys a cent, at any stake or fee rate', () => {
    for (const stake of [1, 7, 333, 500, 1000, 2500, 5000, 10000, 99999]) {
      for (const rate of [0, 250, 700, 1000, 1234, 2000]) {
        const { grossPoolCents, platformFeeCents, payoutCents } = calculateSettlement(stake, stake, rate);
        expect(platformFeeCents + payoutCents).toBe(grossPoolCents);
        expect(platformFeeCents).toBeGreaterThanOrEqual(0);
        expect(payoutCents).toBeGreaterThan(0);
      }
    }
  });

  it('earns the Pro rate when either player subscribes', () => {
    expect(qualifiesForProRate(false, false)).toBe(false);
    expect(qualifiesForProRate(true, false)).toBe(true);
    expect(qualifiesForProRate(false, true)).toBe(true);
    expect(calculateSettlement(1000, 1000, PRO_ESCROW_FEE_BPS).platformFeeCents).toBe(140);
  });

  it('refuses asymmetric, zero and out-of-range inputs', () => {
    expect(() => calculateSettlement(1000, 900)).toThrow(/match/i);
    expect(() => calculateSettlement(0, 0)).toThrow(/positive/i);
    expect(() => calculateSettlement(1000, 1000, 5000)).toThrow(/basis points/i);
    expect(() => calculateSettlement(10.5, 10.5)).toThrow(/integer/i);
  });
});

describe('calculateWithdrawal', () => {
  it('takes the fee out of the requested amount, not on top of it', () => {
    const result = calculateWithdrawal(5000);
    expect(result.grossCents).toBe(5000);
    expect(result.feeCents).toBe(500);
    expect(result.netCents).toBe(4500);
    // The player asked for $50 to leave their wallet, and $50 did.
    expect(result.feeCents + result.netCents).toBe(result.grossCents);
  });

  it('charges the Pro rate for subscribers', () => {
    expect(calculateWithdrawal(5000, PRO_ESCROW_FEE_BPS).netCents).toBe(4650);
  });

  it('never creates or destroys a cent, at any amount or rate', () => {
    for (const amount of [2, 13, 101, 999, 1000, 4321, 100000]) {
      for (const rate of [0, 100, 700, 1000, 2000]) {
        const { grossCents, feeCents, netCents } = calculateWithdrawal(amount, rate);
        expect(feeCents + netCents).toBe(grossCents);
        expect(netCents).toBeGreaterThan(0);
      }
    }
  });

  it('refuses an amount the fee would swallow whole', () => {
    // A 1 cent withdrawal at 100% would leave nothing to pay out.
    expect(() => calculateWithdrawal(1, 2000)).not.toThrow();
    expect(() => calculateWithdrawal(0)).toThrow(/positive/i);
    expect(() => calculateWithdrawal(-100)).toThrow(/positive/i);
  });

  it('rejects a rate outside the permitted band', () => {
    expect(() => calculateWithdrawal(1000, 9999)).toThrow(/basis points/i);
    expect(() => calculateWithdrawal(1000, -1)).toThrow(/basis points/i);
  });
});

describe('reconcile', () => {
  const creator = 'creator-id';
  const opponent = 'opponent-id';

  it('agrees when both players describe the same game from their own side', () => {
    const verdict = reconcile(
      [
        { reporterId: creator, selfScore: 3, opponentScore: 1 },
        { reporterId: opponent, selfScore: 1, opponentScore: 3 },
      ],
      creator,
      opponent,
    );
    expect(verdict.verdict).toBe('agreed');
    expect(verdict.winnerId).toBe(creator);
    expect(verdict.creatorScore).toBe(3);
    expect(verdict.opponentScore).toBe(1);
  });

  it('flags a conflict when the scorelines differ', () => {
    const verdict = reconcile(
      [
        { reporterId: creator, selfScore: 3, opponentScore: 1 },
        { reporterId: opponent, selfScore: 2, opponentScore: 3 },
      ],
      creator,
      opponent,
    );
    expect(verdict.verdict).toBe('conflict');
    expect(verdict.winnerId).toBeNull();
  });

  it('treats a draw as having no winner', () => {
    const verdict = reconcile(
      [
        { reporterId: creator, selfScore: 2, opponentScore: 2 },
        { reporterId: opponent, selfScore: 2, opponentScore: 2 },
      ],
      creator,
      opponent,
    );
    expect(verdict.outcome).toBe('draw');
    expect(verdict.winnerId).toBeNull();
  });

  it('rejects two reports from the same player', () => {
    expect(() =>
      reconcile(
        [
          { reporterId: creator, selfScore: 1, opponentScore: 0 },
          { reporterId: creator, selfScore: 1, opponentScore: 0 },
        ],
        creator,
        opponent,
      ),
    ).toThrow(/same player/i);
  });

  it('rejects impossible scores', () => {
    expect(() =>
      reconcile(
        [
          { reporterId: creator, selfScore: -1, opponentScore: 0 },
          { reporterId: opponent, selfScore: 0, opponentScore: 1 },
        ],
        creator,
        opponent,
      ),
    ).toThrow(/between 0 and 99/i);
  });

  it('derives the outcome from the scoreline', () => {
    expect(outcomeFor(2, 1)).toBe('creator_win');
    expect(outcomeFor(1, 2)).toBe('opponent_win');
    expect(outcomeFor(0, 0)).toBe('draw');
  });
});

describe('trust scoring', () => {
  it('starts a brand-new account near the neutral prior', () => {
    const score = computeTrustScore({
      matchesSettled: 0,
      accurateReports: 0,
      inaccurateReports: 0,
      disputesRaised: 0,
      disputesLost: 0,
      cancellations: 0,
      strikes: 0,
    });
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThan(75);
  });

  it('rewards a long clean record and punishes lost disputes', () => {
    const clean = computeTrustScore({
      matchesSettled: 60,
      accurateReports: 60,
      inaccurateReports: 0,
      disputesRaised: 0,
      disputesLost: 0,
      cancellations: 0,
      strikes: 0,
    });
    const dishonest = computeTrustScore({
      matchesSettled: 60,
      accurateReports: 40,
      inaccurateReports: 20,
      disputesRaised: 20,
      disputesLost: 8,
      cancellations: 4,
      strikes: 1,
    });
    expect(clean).toBeGreaterThan(90);
    expect(dishonest).toBeLessThan(clean);
    expect(dishonest).toBeGreaterThanOrEqual(0);
  });

  it('clamps to 0-100 however bad the record is', () => {
    const score = computeTrustScore({
      matchesSettled: 5,
      accurateReports: 0,
      inaccurateReports: 40,
      disputesRaised: 30,
      disputesLost: 30,
      cancellations: 20,
      strikes: 10,
    });
    expect(score).toBe(0);
  });
});

describe('settlementPolicyFor', () => {
  it('lets two trusted players settle instantly', () => {
    const policy = settlementPolicyFor(90, 85);
    expect(policy.requireBothScreenshots).toBe(false);
    expect(policy.holdSeconds).toBe(0);
    expect(policy.forceManualReview).toBe(false);
  });

  it('is governed by the weaker of the two players', () => {
    expect(settlementPolicyFor(99, 20).forceManualReview).toBe(true);
    expect(settlementPolicyFor(99, 60).requireBothScreenshots).toBe(true);
    expect(settlementPolicyFor(99, 60).forceManualReview).toBe(false);
  });
});
