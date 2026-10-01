import { PLATFORM_REVENUE, matchEscrow } from '@escrow/shared';
import { makeUser, ULTIMATE_TEAM } from './factories';
import { createMatch, joinMatch } from '../src/modules/matches/matches.service';
import { submitResult, sweepLapsedMatches } from '../src/modules/results/results.service';
import { caseFile, queue, raiseDispute, resolveDispute } from '../src/modules/disputes/disputes.service';
import { accountBalance, getWallet, reconcileWallets } from '../src/db/repos/ledger.repo';
import { findMatchById, updateMatch } from '../src/db/repos/matches.repo';
import { findUserById } from '../src/db/repos/users.repo';
import { findDisputeByMatch } from '../src/db/repos/misc.repo';
import { postChatMessage } from '../src/modules/matches/matches.service';

async function disputedMatch() {
  const creator = await makeUser({ balanceCents: 5000, trustScore: 90 });
  const opponent = await makeUser({ balanceCents: 5000, trustScore: 90 });
  const moderator = await makeUser({ role: 'moderator' });
  const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 });
  await joinMatch(opponent, match.id);
  await postChatMessage(creator, match.id, 'gg, see you on the pitch');
  await submitResult(creator, { matchId: match.id, selfScore: 3, opponentScore: 1 });
  await submitResult(opponent, { matchId: match.id, selfScore: 2, opponentScore: 1 });
  const dispute = (await findDisputeByMatch(match.id))!;
  return { creator, opponent, moderator, match, dispute };
}

describe('dispute queue', () => {
  it('holds escrow while a case is open and lists it for moderators', async () => {
    const { match, dispute } = await disputedMatch();
    expect(dispute.status).toBe('open');
    expect(await accountBalance(matchEscrow(match.id))).toBe(5000);
    const open = await queue('open');
    expect(open.map((d) => d.id)).toContain(dispute.id);
  });

  it('gives a moderator the whole case on one screen', async () => {
    const { dispute, creator, opponent } = await disputedMatch();
    const file = await caseFile(dispute.id);

    expect(file.results).toHaveLength(2);
    expect(file.chat.map((m) => m.body)).toContain('gg, see you on the pitch');
    expect(file.creator.id).toBe(creator.id);
    expect(file.opponent!.id).toBe(opponent.id);
    expect(file.history).toHaveLength(2);
    expect(file.history[0]).toHaveProperty('disputesLost');
  });

  it('pays the winner the moderator names, and marks the case resolved', async () => {
    const { creator, opponent, moderator, match, dispute } = await disputedMatch();

    await resolveDispute(moderator, {
      disputeId: dispute.id,
      resolution: 'creator_wins',
      notes: 'Creator screenshot matches the FUT match facts screen; opponent report contradicted.',
    });

    const settled = await findMatchById(match.id);
    expect(settled!.status).toBe('settled');
    expect(settled!.winnerId).toBe(creator.id);
    expect((await getWallet(creator.id))!.availableCents).toBe(2500 + 4500);
    expect((await getWallet(opponent.id))!.availableCents).toBe(2500);
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(500);
    expect(await accountBalance(matchEscrow(match.id))).toBe(0);
    expect(await reconcileWallets()).toEqual([]);

    const resolved = (await findDisputeByMatch(match.id))!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toBe(moderator.id);
  });

  it('moves trust in both directions after a ruling', async () => {
    const { creator, opponent, moderator, dispute } = await disputedMatch();
    const before = (await findUserById(opponent.id))!.trustScore;

    await resolveDispute(moderator, {
      disputeId: dispute.id,
      resolution: 'creator_wins',
      notes: 'Evidence supports the creator.',
    });

    const after = (await findUserById(opponent.id))!.trustScore;
    expect(after).toBeLessThan(before);
  });

  it('returns both stakes and takes no rake when a match is voided', async () => {
    const { creator, opponent, moderator, match, dispute } = await disputedMatch();

    await resolveDispute(moderator, {
      disputeId: dispute.id,
      resolution: 'void_refund',
      notes: 'Neither screenshot is legible; no way to rule.',
    });

    expect((await findMatchById(match.id))!.status).toBe('voided');
    expect((await getWallet(creator.id))!.availableCents).toBe(5000);
    expect((await getWallet(opponent.id))!.availableCents).toBe(5000);
    expect(await accountBalance(PLATFORM_REVENUE)).toBe(0);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('refuses to rule twice on the same case', async () => {
    const { moderator, dispute } = await disputedMatch();
    await resolveDispute(moderator, {
      disputeId: dispute.id,
      resolution: 'creator_wins',
      notes: 'First and only ruling.',
    });
    await expect(
      resolveDispute(moderator, {
        disputeId: dispute.id,
        resolution: 'opponent_wins',
        notes: 'Trying to flip the payout.',
      }),
    ).rejects.toMatchObject({ code: 'already_resolved' });
  });

  it('reopens reporting when a dispute is dismissed', async () => {
    const { moderator, match, dispute } = await disputedMatch();
    await resolveDispute(moderator, {
      disputeId: dispute.id,
      resolution: 'dismissed',
      notes: 'Both players agreed to re-report after a miscount.',
    });
    const reopened = await findMatchById(match.id);
    expect(reopened!.status).toBe('awaiting_results');
    expect(await accountBalance(matchEscrow(match.id))).toBe(5000);
  });

  it('issues a strike when the moderator asks for one', async () => {
    const { opponent, moderator, dispute } = await disputedMatch();
    await resolveDispute(moderator, {
      disputeId: dispute.id,
      resolution: 'creator_wins',
      notes: 'Opponent submitted a screenshot from a different match.',
      strikeUserId: opponent.id,
    });
    const struck = await findUserById(opponent.id);
    expect(struck!.strikes).toBe(1);
  });

  it('escalates rather than forfeits when the opponent never reports', async () => {
    const creator = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const opponent = await makeUser({ balanceCents: 5000, trustScore: 90 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);
    await submitResult(creator, { matchId: match.id, selfScore: 4, opponentScore: 0 });

    // Wind the reporting deadline back to simulate the window lapsing.
    await updateMatch(match.id, { reportDeadlineAt: new Date(Date.now() - 60_000).toISOString() });
    const escalated = await sweepLapsedMatches();

    expect(escalated).toContain(match.id);
    expect((await findMatchById(match.id))!.status).toBe('disputed');
    // Crucially, nobody was paid on one player's word.
    expect(await accountBalance(matchEscrow(match.id))).toBe(2000);
    expect((await findUserById(opponent.id))!.trustScore).toBeLessThan(90);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('lets a participant open a case directly', async () => {
    const creator = await makeUser({ balanceCents: 5000 });
    const opponent = await makeUser({ balanceCents: 5000 });
    const stranger = await makeUser({ balanceCents: 5000 });
    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 1000 });
    await joinMatch(opponent, match.id);

    await expect(raiseDispute(stranger, match.id, 'let me in')).rejects.toMatchObject({
      code: 'not_a_participant',
    });

    const dispute = await raiseDispute(creator, match.id, 'Opponent quit at 80 minutes while losing 3-0.');
    expect(dispute.raisedBy).toBe(creator.id);
    expect((await findMatchById(match.id))!.status).toBe('disputed');
  });
});
