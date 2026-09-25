import { EventEmitter } from 'events';

/**
 * Decouples domain services from the socket server.
 *
 * Services publish facts here; the Socket.io gateway is one subscriber. That
 * keeps every service testable without opening a socket, and means a dropped
 * websocket layer degrades the product (no live updates) rather than breaking
 * settlement.
 */
export type RealtimeScope =
  | { kind: 'user'; userId: string }
  | { kind: 'match'; matchId: string }
  | { kind: 'lobby' };

export interface RealtimeMessage {
  scope: RealtimeScope;
  event: string;
  payload: unknown;
}

class RealtimeBus extends EventEmitter {
  publish(message: RealtimeMessage): void {
    this.emit('message', message);
  }

  toUser(userId: string, event: string, payload: unknown): void {
    this.publish({ scope: { kind: 'user', userId }, event, payload });
  }

  toMatch(matchId: string, event: string, payload: unknown): void {
    this.publish({ scope: { kind: 'match', matchId }, event, payload });
  }

  toLobby(event: string, payload: unknown): void {
    this.publish({ scope: { kind: 'lobby' }, event, payload });
  }
}

export const realtime = new RealtimeBus();

// Services fire and forget; without a listener Node would otherwise warn about
// unhandled 'error' events only, but an explicit no-op keeps intent clear.
realtime.setMaxListeners(50);

export const ROOM = {
  user: (userId: string) => `user:${userId}`,
  match: (matchId: string) => `match:${matchId}`,
  lobby: 'lobby',
};
