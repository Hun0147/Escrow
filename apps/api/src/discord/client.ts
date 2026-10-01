import { AppError } from '../common/errors';

/**
 * Discord, outbound only.
 *
 * Goal 27 sends direct messages and reads nothing back. There is no command
 * handling, no `/settle`, no bot that can be talked into moving money — the
 * same rule that keeps settlement off the websocket. A compromised bot token
 * costs us the ability to send notifications and nothing else.
 */
export interface DiscordProfile {
  id: string;
  username: string;
}

export interface DiscordClient {
  readonly name: 'rest' | 'disabled';
  /** Exchanges an OAuth authorisation code for the user's Discord identity. */
  identify(code: string, redirectUri: string): Promise<DiscordProfile>;
  /** Opens a DM channel with a user and sends one message. */
  sendDirectMessage(discordId: string, content: string): Promise<void>;
}

const API_BASE = 'https://discord.com/api/v10';

export class RestDiscordClient implements DiscordClient {
  readonly name = 'rest' as const;

  constructor(
    private readonly botToken: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly apiBase = API_BASE,
  ) {}

  async identify(code: string, redirectUri: string): Promise<DiscordProfile> {
    const token = await this.form('/oauth2/token', {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetch(`${this.apiBase}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const profile = (await response.json()) as Record<string, any>;
    if (!response.ok || !profile?.id) {
      throw new AppError(502, 'discord_error', 'Discord did not return an account');
    }
    return {
      id: String(profile.id),
      username: String(profile.global_name ?? profile.username ?? 'unknown'),
    };
  }

  async sendDirectMessage(discordId: string, content: string): Promise<void> {
    // A DM needs a channel first; Discord returns the existing one if there is
    // already a conversation, so this is safe to call every time.
    const channel = await this.json('/users/@me/channels', { recipient_id: discordId });
    const channelId = channel?.id;
    if (!channelId) throw new AppError(502, 'discord_error', 'Discord did not open a DM channel');
    await this.json(`/channels/${channelId}/messages`, { content });
  }

  private async form(path: string, body: Record<string, string>) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const payload = (await response.json()) as Record<string, any>;
    if (!response.ok) {
      throw new AppError(
        502,
        'discord_error',
        payload?.error_description ?? 'Discord rejected the authorisation code',
      );
    }
    return payload;
  }

  private async json(path: string, body: unknown): Promise<Record<string, any>> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // Discord answers a rate limit with the wait in seconds. Honour it once
    // rather than hammering; the caller retries later if this still fails.
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after') ?? '1');
      throw new AppError(
        429,
        'discord_rate_limited',
        `Discord rate limited this send; retry after ${retry}s`,
      );
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new AppError(502, 'discord_error', `Discord returned ${response.status}: ${detail.slice(0, 200)}`);
    }
    return response.status === 204 ? {} : ((await response.json()) as Record<string, any>);
  }
}

/** What runs when Discord is not configured: linking is refused, sends are
 *  silently skipped. The product works without it. */
export class DisabledDiscordClient implements DiscordClient {
  readonly name = 'disabled' as const;

  async identify(): Promise<DiscordProfile> {
    throw new AppError(503, 'discord_unconfigured', 'Discord is not configured on this deployment');
  }

  async sendDirectMessage(): Promise<void> {
    // Deliberately a no-op rather than a throw: a deployment without Discord
    // must not log an error for every notification it produces.
  }
}

let client: DiscordClient | null = null;

/**
 * Discord activates on configuration, not a flag — all three secrets or
 * nothing, so a half-configured deployment cannot half-work.
 */
export function discordClient(): DiscordClient {
  if (client) return client;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  client =
    botToken && clientId && clientSecret
      ? new RestDiscordClient(botToken, clientId, clientSecret)
      : new DisabledDiscordClient();
  return client;
}

export function discordConfigured(): boolean {
  return discordClient().name === 'rest';
}

/** Test seam. */
export function setDiscordClient(next: DiscordClient | null): void {
  client = next;
}
