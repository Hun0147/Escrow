import {
  DEFAULT_RAKE_BPS,
  PRO_RAKE_BPS,
  calculateSettlement,
  computeTrustScore,
  outcomeFor,
  rakeForMatch,
  reconcile,
  settlementPolicyFor,
} from '@escrow/shared';

describe('calculateSettlement', () => {
  it('takes a 10% rake by default and pays the rest to the winner', () => {
    const result = calculateSettlement(2500, 2500);
    expect(result.grossPoolCents).toBe(5000);
    expect(result.platformFeeCents).toBe(500);
    expect(result.payoutCents).toBe(4500);
    expect(result.rakeBps).toBe(DEFAULT_RAKE_BPS);
  });

  it('never creates or destroys a cent, at any stake or rake', () => {
    for (const stake of [1, 7, 333, 500, 1000, 2500, 5000, 10000, 99999]) {
      for (const rake of [0, 250, 700, 1000, 1234, 2000]) {
        const { grossPoolCents, platformFeeCents, payoutCents } = calculateSettlement(stake, stake, rake);
        expect(platformFeeCents + payoutCents).toBe(grossPoolCents);
        expect(platformFeeCents).toBeGreaterThanOrEqual(0);
        expect(payoutCents).toBeGreaterThan(0);
      }
    }
  });

  it('charges the Pro rake when either player subscribes', () => {
    expect(rakeForMatch(false, false)).toBe(DEFAULT_RAKE_BPS);
    expect(rakeForMatch(true, false)).toBe(PRO_RAKE_BPS);
    expect(rakeForMatch(false, true)).toBe(PRO_RAKE_BPS);
    expect(calculateSettlement(1000, 1000, PRO_RAKE_BPS).platformFeeCents).toBe(140);
  });

  it('refuses asymmetric, zero and out-of-range inputs', () => {
    expect(() => calculateSettlement(1000, 900)).toThrow(/match/i);
    expect(() => calculateSettlement(0, 0)).toThrow(/positive/i);
    expect(() => calculateSettlement(1000, 1000, 5000)).toThrow(/basis points/i);
    expect(() => calculateSettlement(10.5, 10.5)).toThrow(/integer/i);
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
