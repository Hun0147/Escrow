import { GameMode } from '@escrow/shared';

/**
 * Matchmaking queue.
 *
 * Redis is the intended backing store (it is what makes the queue shared
 * across API instances), but the platform must run without it in development
 * and in CI, so the interface has an in-memory implementation too. Nothing
 * else in the codebase knows which one is live.
 */
export interface QueueTicket {
  userId: string;
  stakeCents: number;
  gameMode: GameMode;
  skillTier: string;
  enqueuedAt: number;
}

export interface MatchmakingQueue {
  readonly kind: 'redis' | 'memory';
  enqueue(ticket: QueueTicket): Promise<void>;
  /** Removes and returns the best waiting opponent, if there is one. */
  takeOpponent(ticket: QueueTicket): Promise<QueueTicket | null>;
  remove(userId: string): Promise<void>;
  size(): Promise<number>;
}

function keyFor(ticket: Pick<QueueTicket, 'stakeCents' | 'gameMode'>): string {
  return `${ticket.gameMode}:${ticket.stakeCents}`;
}

class MemoryQueue implements MatchmakingQueue {
  readonly kind = 'memory';
  private readonly buckets = new Map<string, QueueTicket[]>();

  async enqueue(ticket: QueueTicket): Promise<void> {
    await this.remove(ticket.userId);
    const key = keyFor(ticket);
    const bucket = this.buckets.get(key) ?? [];
    bucket.push(ticket);
    this.buckets.set(key, bucket);
  }

  async takeOpponent(ticket: QueueTicket): Promise<QueueTicket | null> {
    const bucket = this.buckets.get(keyFor(ticket)) ?? [];
    // Longest wait first: nobody should sit in the queue while later arrivals
    // get matched around them.
    const index = bucket.findIndex((entry) => entry.userId !== ticket.userId);
    if (index === -1) return null;
    const [opponent] = bucket.splice(index, 1);
    return opponent;
  }

  async remove(userId: string): Promise<void> {
    for (const [key, bucket] of this.buckets) {
      const filtered = bucket.filter((entry) => entry.userId !== userId);
      if (filtered.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, filtered);
    }
  }

  async size(): Promise<number> {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.length;
    return total;
  }
}

class RedisQueue implements MatchmakingQueue {
  readonly kind = 'redis';
  constructor(private readonly client: any) {}

  private key(ticket: Pick<QueueTicket, 'stakeCents' | 'gameMode'>): string {
    return `goal27:queue:${keyFor(ticket)}`;
  }

  async enqueue(ticket: QueueTicket): Promise<void> {
    await this.remove(ticket.userId);
    await this.client.rPush(this.key(ticket), JSON.stringify(ticket));
    await this.client.hSet('goal27:queue:index', ticket.userId, this.key(ticket));
  }

  async takeOpponent(ticket: QueueTicket): Promise<QueueTicket | null> {
    const key = this.key(ticket);
    const entries: string[] = await this.client.lRange(key, 0, -1);
    for (const raw of entries) {
      const candidate: QueueTicket = JSON.parse(raw);
      if (candidate.userId === ticket.userId) continue;
      await this.client.lRem(key, 1, raw);
      await this.client.hDel('goal27:queue:index', candidate.userId);
      return candidate;
    }
    return null;
  }

  async remove(userId: string): Promise<void> {
    const key = await this.client.hGet('goal27:queue:index', userId);
    if (!key) return;
    const entries: string[] = await this.client.lRange(key, 0, -1);
    for (const raw of entries) {
      if (JSON.parse(raw).userId === userId) await this.client.lRem(key, 1, raw);
    }
    await this.client.hDel('goal27:queue:index', userId);
  }

  async size(): Promise<number> {
    return this.client.hLen('goal27:queue:index');
  }
}

let queue: MatchmakingQueue | null = null;

export async function matchmakingQueue(): Promise<MatchmakingQueue> {
  if (queue) return queue;
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const mod: any = await import('redis' as string);
      const client = mod.createClient({ url });
      await client.connect();
      queue = new RedisQueue(client);
      return queue;
    } catch (err) {
      console.warn(`Redis unavailable (${(err as Error).message}); using the in-memory queue`);
    }
  }
  queue = new MemoryQueue();
  return queue;
}

export function setMatchmakingQueue(next: MatchmakingQueue | null): void {
  queue = next;
}
