import { SelfUser } from '@escrow/shared';
import { UserRow, findUserByDiscordId, toSelfUser, updateUser } from '../../db/repos/users.repo';
import { raiseFraudFlag } from '../../db/repos/fraud.repo';
import { conflict, forbidden } from '../../common/errors';
import { discordClient, discordConfigured } from '../../discord/client';

/**
 * Linking a Discord account.
 *
 * Ownership is proved by OAuth — the player authorises Goal 27 on Discord and
 * we exchange the code ourselves. We never ask for a Discord password, and the
 * access token is used once to read the account id and then discarded: we only
 * ever need the id, and holding a token we do not need is a liability.
 */
export async function linkDiscord(
  user: UserRow,
  code: string,
  redirectUri: string,
): Promise<SelfUser> {
  const profile = await discordClient().identify(code, redirectUri);

  const existing = await findUserByDiscordId(profile.id);
  if (existing && existing.id !== user.id) {
    // One Discord account per player. Two Goal 27 accounts behind one Discord
    // identity is the same signal as a shared device.
    await raiseFraudFlag({
      userId: user.id,
      relatedUserId: existing.id,
      kind: 'shared_discord_account',
      detail: `Discord ${profile.id} is already linked to another account`,
    });
    throw conflict('discord_taken', 'That Discord account is already linked to another player');
  }

  return toSelfUser(
    await updateUser(user.id, {
      discordId: profile.id,
      discordUsername: profile.username,
      discordDmEnabled: true,
      discordLinkedAt: new Date().toISOString(),
    }),
  );
}

export async function unlinkDiscord(user: UserRow): Promise<SelfUser> {
  return toSelfUser(
    await updateUser(user.id, {
      discordId: null,
      discordUsername: null,
      discordLinkedAt: null,
    }),
  );
}

/** Turning DMs off keeps the link — a player who wants quiet should not have
 *  to re-authorise later. */
export async function setDiscordDms(user: UserRow, enabled: boolean): Promise<SelfUser> {
  if (!user.discord) {
    throw forbidden('discord_not_linked', 'Link a Discord account before changing DM settings');
  }
  return toSelfUser(await updateUser(user.id, { discordDmEnabled: enabled }));
}

export interface DiscordStatus {
  configured: boolean;
  /** Where the client should send the player to authorise, when configured. */
  authorizeUrl: string | null;
  link: SelfUser['discord'];
}

export function discordStatus(user: UserRow, redirectUri: string): DiscordStatus {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const configured = discordConfigured();
  return {
    configured,
    authorizeUrl:
      configured && clientId
        ? `https://discord.com/oauth2/authorize?client_id=${clientId}` +
          `&response_type=code&scope=identify` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}`
        : null,
    link: user.discord,
  };
}
