import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { verifyToken } from '../common/jwt';
import { findUserById } from '../db/repos/users.repo';
import { getWallet } from '../db/repos/ledger.repo';
import { findMatchById } from '../db/repos/matches.repo';
import { listChatMessages } from '../db/repos/misc.repo';
import { ROOM, realtime } from './bus';

/**
 * Socket.io gateway.
 *
 * Sockets are read-mostly: they carry lobby updates, chat, ready state,
 * countdowns and wallet pushes. Anything that moves money still goes over
 * HTTP, where it is validated and transactional — a websocket frame is not a
 * place to authorise a payout.
 */
export function attachRealtime(server: HttpServer): Server {
  const io = new Server(server, {
    cors: { origin: process.env.WEB_ORIGIN ?? '*' },
    // Faster than the default so a player who pulls their network cable is
    // detected inside a match room rather than a minute later.
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token ?? socket.handshake.query?.token;
    if (typeof token !== 'string') return next(new Error('Missing auth token'));
    try {
      const { sub } = verifyToken(token);
      const user = await findUserById(sub);
      if (!user || user.bannedAt) return next(new Error('Not authorised'));
      socket.data.userId = user.id;
      socket.data.handle = user.handle;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId: string = socket.data.userId;
    socket.join(ROOM.user(userId));
    socket.join(ROOM.lobby);

    void getWallet(userId).then((wallet) => {
      if (wallet) socket.emit('wallet:updated', wallet);
    });

    socket.on('match:join', async (matchId: string, ack?: (payload: unknown) => void) => {
      const match = await findMatchById(matchId);
      if (!match || (match.creatorId !== userId && match.opponentId !== userId)) {
        ack?.({ error: 'not_a_participant' });
        return;
      }
      socket.join(ROOM.match(matchId));
      socket.data.matchId = matchId;
      const history = await listChatMessages(matchId);
      ack?.({ match, chat: history });
      socket.to(ROOM.match(matchId)).emit('presence:joined', {
        matchId,
        userId,
        handle: socket.data.handle,
      });
    });

    socket.on('match:leave', (matchId: string) => {
      socket.leave(ROOM.match(matchId));
      socket.to(ROOM.match(matchId)).emit('presence:left', { matchId, userId });
    });

    // Opponent-disconnect detection: the room is told immediately, so the UI
    // can show "opponent lost connection" and offer to raise a dispute rather
    // than leaving someone staring at a dead chat.
    socket.on('disconnect', () => {
      const matchId: string | undefined = socket.data.matchId;
      if (matchId) {
        socket.to(ROOM.match(matchId)).emit('presence:disconnected', {
          matchId,
          userId,
          at: new Date().toISOString(),
        });
      }
    });
  });

  const forward = (message: Parameters<typeof handleMessage>[1]) => handleMessage(io, message);
  realtime.on('message', forward);
  io.on('close', () => realtime.off('message', forward));

  return io;
}

function handleMessage(io: Server, message: { scope: any; event: string; payload: unknown }): void {
  if (message.scope.kind === 'user') io.to(ROOM.user(message.scope.userId)).emit(message.event, message.payload);
  else if (message.scope.kind === 'match') io.to(ROOM.match(message.scope.matchId)).emit(message.event, message.payload);
  else io.to(ROOM.lobby).emit(message.event, message.payload);
}
