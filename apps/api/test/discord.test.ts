import { Notification } from '@escrow/shared';
import { makeUser, ULTIMATE_TEAM } from './factories';
import {
  DiscordClient,
  DiscordProfile,
  setDiscordClient,
} from '../src/discord/client';
import { deliverToDiscord, startDiscordRelay, stopDiscordRelay } from '../src/discord/relay';
import { formatDm, truncateForDiscord, DISCORD_MAX_MESSAGE } from '../src/discord/messages';
import { linkDiscord, setDiscordDms, unlinkDiscord } from '../src/modules/onboarding/discord.service';
import { notify } from '../src/modules/notifications/notifications.service';
import { findUserById, updateUser } from '../src/db/repos/users.repo';
import { listOpenFraudFlags } from '../src/db/repos/fraud.repo';
import { createMatch, joinMatch } from '../src/modules/matches/matches.service';
import { submitResult } from '../src/modules/results/results.service';
import { reconcileWallets } from '../src/db/repos/ledger.repo';
import { setSetting } from '../src/common/settings';
import { pool } from '../src/db/pool';

/** Records what would have been sent, so delivery is testable without a bot. */
class FakeDiscord implements DiscordClient {
  readonly name = 'rest' as const;
  sent: { discordId: string; content: string }[] = [];
  profile: DiscordProfile = { id: 'discord-1', username: 'striker' };
  failNext = false;

  async identify(): Promise<DiscordProfile> {
    return this.profile;
  }

  async sendDirectMessage(discordId: string, content: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Discord returned 500');
    }
    this.sent.push({ discordId, content });
  }
}

let discord: FakeDiscord;

beforeEach(() => {
  discord = new FakeDiscord();
  setDiscordClient(discord);
});

afterEach(() => {
  stopDiscordRelay();
  setDiscordClient(null);
});

async function linkedUser(overrides = {}) {
  const user = await makeUser(overrides);
  return linkDiscord(user, 'oauth-code', 'https://goal27.test/settings/discord').then(() =>
    findUserById(user.id).then((u) => u!),
  );
}

describe('linking a Discord account', () => {
  it('stores the identity Discord vouched for, and enables DMs', async () => {
    const user = await makeUser();
    const linked = await linkDiscord(user, 'oauth-code', 'https://goal27.test/cb');

    expect(linked.discord).toMatchObject({ discordId: 'discord-1', username: 'striker', dmEnabled: true });
  });

  it('refuses a Discord account already linked to another player, and flags it', async () => {
    await linkedUser();
    const second = await makeUser();

    await expect(linkDiscord(second, 'oauth-code', 'https://goal27.test/cb')).rejects.toMatchObject({
      code: 'discord_taken',
    });
    // Two Goal 27 accounts behind one Discord identity is the same signal as
    // a shared device.
    expect((await listOpenFraudFlags()).map((f) => f.kind)).toContain('shared_discord_account');
  });

  it('keeps the link when a player only wants quiet', async () => {
    const user = await linkedUser();
    const quiet = await setDiscordDms(user, false);

    expect(quiet.discord).toMatchObject({ discordId: 'discord-1', dmEnabled: false });
  });

  it('unlinks cleanly', async () => {
    const user = await linkedUser();
    const unlinked = await unlinkDiscord(user);
    expect(unlinked.discord).toBeNull();
  });

  it('refuses a DM preference change for an unlinked account', async () => {
    const user = await makeUser();
    await expect(setDiscordDms(user, true)).rejects.toMatchObject({ code: 'discord_not_linked' });
  });
});

describe('delivering a DM', () => {
  const notification = (over: Partial<Notification> = {}): Notification => ({
    id: '00000000-0000-0000-0000-000000000001',
    userId: 'u',
    type: 'result_submitted',
    title: 'Opponent reported the result',
    body: 'Submit your score and screenshot to settle the match.',
    matchId: null,
    readAt: null,
    discordDeliveredAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  });

  it('sends to a linked player who wants DMs', async () => {
    const user = await linkedUser();
    const n = await notify({ userId: user.id, type: 'result_submitted', title: 'T', body: 'B' });

    expect(await deliverToDiscord(n)).toBe('sent');
    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0].discordId).toBe('discord-1');
  });

  it('sends once however many times it is asked', async () => {
    const user = await linkedUser();
    const n = await notify({ userId: user.id, type: 'result_submitted', title: 'T', body: 'B' });

    expect(await deliverToDiscord(n)).toBe('sent');
    expect(await deliverToDiscord(n)).toBe('already_delivered');
    expect(await deliverToDiscord(n)).toBe('already_delivered');
    expect(discord.sent).toHaveLength(1);
  });

  it('stays silent for a player who has not linked', async () => {
    const user = await makeUser();
    const n = await notify({ userId: user.id, type: 'result_submitted', title: 'T', body: 'B' });
    expect(await deliverToDiscord(n)).toBe('not_linked');
    expect(discord.sent).toHaveLength(0);
  });

  it('respects a player who turned DMs off', async () => {
    const user = await linkedUser();
    await setDiscordDms(user, false);
    const n = await notify({ userId: user.id, type: 'result_submitted', title: 'T', body: 'B' });

    expect(await deliverToDiscord(n)).toBe('dms_disabled');
    expect(discord.sent).toHaveLength(0);
  });

  it('does not DM wallet movements — a message per deposit trains people to ignore the channel', async () => {
    const user = await linkedUser();
    const n = await notify({ userId: user.id, type: 'wallet_credited', title: 'T', body: 'B' });
    expect(await deliverToDiscord(n)).toBe('type_not_dm_worthy');
    expect(discord.sent).toHaveLength(0);
  });

  it('honours a changed list of DM-worthy types', async () => {
    await setSetting('discord_dm_types', ['match_settled']);
    const user = await linkedUser();

    const skipped = await notify({ userId: user.id, type: 'result_submitted', title: 'T', body: 'B' });
    expect(await deliverToDiscord(skipped)).toBe('type_not_dm_worthy');

    const wanted = await notify({ userId: user.id, type: 'match_settled', title: 'T', body: 'B' });
    expect(await deliverToDiscord(wanted)).toBe('sent');
  });

  it('releases the claim when Discord fails, so a retry can still reach the player', async () => {
    const user = await linkedUser();
    const n = await notify({ userId: user.id, type: 'result_submitted', title: 'T', body: 'B' });

    discord.failNext = true;
    expect(await deliverToDiscord(n)).toBe('failed');
    const { rows } = await pool.query('SELECT discord_delivered_at, discord_error FROM notifications WHERE id = $1', [n.id]);
    expect(rows[0].discord_delivered_at).toBeNull();
    expect(rows[0].discord_error).toMatch(/500/);

    // Silence is worse than a duplicate here: the retry must go through.
    expect(await deliverToDiscord(n)).toBe('sent');
    expect(discord.sent).toHaveLength(1);
  });

  it('does nothing at all when Discord is not configured', async () => {
    setDiscordClient(null); // falls back to the disabled client
    const user = await makeUser();
    const n = await notify({ userId: user.id, type: 'result_submitted', title: 'T', body: 'B' });
    expect(await deliverToDiscord(n)).toBe('discord_unconfigured');
  });
});

describe('what the DM says', () => {
  const base: Notification = {
    id: 'n1', userId: 'u', type: 'result_submitted',
    title: 'Opponent reported the result',
    body: 'Submit your score and screenshot to settle the match.',
    matchId: 'match-abc', readAt: null, discordDeliveredAt: null,
    createdAt: new Date().toISOString(),
  };

  it('leads with the reporting clock, because that is the point of the feature', () => {
    const content = formatDm({ notification: base, webOrigin: 'https://goal27.test', deadlineMinutes: 7 });
    expect(content).toMatch(/7 minutes/);
    expect(content).toMatch(/moderator/);
    expect(content).toContain('https://goal27.test/match/match-abc');
  });

  it('uses the singular for one minute and says so plainly when the window has closed', () => {
    expect(formatDm({ notification: base, webOrigin: 'https://x.test', deadlineMinutes: 1 })).toMatch(/1 minute\b/);
    expect(formatDm({ notification: base, webOrigin: 'https://x.test', deadlineMinutes: 0 })).toMatch(/window has closed/);
  });

  it('always carries a link to act on', () => {
    const noMatch = { ...base, type: 'kyc_updated' as const, matchId: null };
    expect(formatDm({ notification: noMatch, webOrigin: 'https://x.test' })).toContain('https://x.test/lobby');
  });

  it('stays inside the Discord message limit', () => {
    const huge = { ...base, body: 'x'.repeat(5000) };
    const content = truncateForDiscord(formatDm({ notification: huge, webOrigin: 'https://x.test' }));
    expect(content.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE);
  });
});

describe('the relay, end to end on a real match', () => {
  it('DMs the opponent when a result is reported, with the clock in it', async () => {
    startDiscordRelay();

    const creator = await makeUser({ balanceCents: 10000, trustScore: 92 });
    const opponentBase = await makeUser({ balanceCents: 10000, trustScore: 92 });
    await linkDiscord(opponentBase, 'oauth-code', 'https://goal27.test/cb');
    const opponent = (await findUserById(opponentBase.id))!;

    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 });
    await joinMatch(opponent, match.id);
    discord.sent = []; // ignore the "opponent found" DM to the creator's side

    await submitResult(creator, { matchId: match.id, selfScore: 2, opponentScore: 1 });
    // The relay is fire-and-forget off the bus; give it a tick to land.
    await new Promise((r) => setTimeout(r, 400));

    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0].content).toMatch(/reported the result/i);
    expect(discord.sent[0].content).toMatch(/minutes?\*\* to submit yours/);
    expect(discord.sent[0].content).toContain(match.id);
    expect(await reconcileWallets()).toEqual([]);
  });

  it('a failing Discord never affects settlement', async () => {
    startDiscordRelay();
    const creator = await makeUser({ balanceCents: 10000, trustScore: 92 });
    const opponentBase = await makeUser({ balanceCents: 10000, trustScore: 92 });
    await linkDiscord(opponentBase, 'oauth-code', 'https://goal27.test/cb');
    const opponent = (await findUserById(opponentBase.id))!;

    const match = await createMatch(creator, { gameMode: ULTIMATE_TEAM, stakeCents: 2500 });
    await joinMatch(opponent, match.id);

    // Every send fails from here on.
    discord.sendDirectMessage = async () => {
      throw new Error('Discord is down');
    };

    await submitResult(creator, { matchId: match.id, selfScore: 3, opponentScore: 0 });
    await submitResult(opponent, { matchId: match.id, selfScore: 0, opponentScore: 3 });
    await new Promise((r) => setTimeout(r, 400));

    const { rows } = await pool.query('SELECT status, winner_id FROM matches WHERE id = $1', [match.id]);
    expect(rows[0].status).toBe('settled');
    expect(rows[0].winner_id).toBe(creator.id);
    expect(await reconcileWallets()).toEqual([]);
  });
});
