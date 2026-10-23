/**
 * The live socket (socket.io), shared by index.ts (one process, WORKER=0) and web.ts (fix202: the web process holds the
 * visitors' sockets; the worker's live poll reaches it through live_state). Each socket joins 'full' (Pro / admin) or
 * 'teaser' (everyone else: predictions trimmed) and at most one match room.
 */
import type http from 'http';
import { Server } from 'socket.io';
import logger from '../utils/logger';
import { parseCookies, SESSION_COOKIE, userForToken, accessOf, canSeeFull, teaseDeep } from './auth';
import { perGames } from './perf';

const isDev = (process.env.NODE_ENV || 'development') !== 'production';
// In development accept any local origin (Vite may switch ports, 127.0.0.1 vs localhost, etc.)
export const allowedOrigins = (process.env.CORS_ORIGIN || (isDev ? 'http://localhost:3000' : 'https://sportlikely.com,https://www.sportlikely.com,https://bettobeat.com,https://www.bettobeat.com'))
  .split(',')
  .map(o => o.trim());
export const corsOrigin = isDev ? true : allowedOrigins;

// Private beta credentials (the gate in index.ts); empty password = open site
const SITE_USER = process.env.SITE_USER || '';
export const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
export const SITE_AUTH = SITE_PASSWORD ? 'Basic ' + Buffer.from(`${SITE_USER}:${SITE_PASSWORD}`).toString('base64') : '';

export function liveSocket(server: http.Server): Server {
  const io = new Server(server, {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    // Socket.io bypasses Express middleware, so the gate is applied here too
    allowRequest: (req, cb) => cb(null, !SITE_AUTH || req.headers.authorization === SITE_AUTH)
  });

  // Each socket joins 'full' (premium/admin) or 'teaser' (anonymous/free) — predictions are trimmed for 'teaser'
  io.use((socket, next) => {
    try {
      const cookies = parseCookies(socket.request.headers.cookie);
      const user = userForToken(cookies[SESSION_COOKIE]);
      socket.data.full = canSeeFull(accessOf(user));
    } catch {
      socket.data.full = false;
    }
    next();
  });

  io.on('connection', socket => {
    logger.info(`Client connected: ${socket.id}`);

    const tier = socket.data.full ? 'full' : 'teaser';
    socket.join(tier);

    socket.on('subscribe_match', (matchId: number) => {
      const id = Number(matchId);
      if (!Number.isInteger(id) || id <= 0) return;
      // one match page at a time is plenty: drop older match rooms
      for (const room of socket.rooms) if (room.startsWith('match:') && room !== `match:${id}:${tier}`) socket.leave(room);
      socket.join(`match:${id}:${tier}`);
    });

    socket.on('unsubscribe_match', (matchId: number) => {
      socket.leave(`match:${matchId}:${tier}`);
    });

    socket.on('disconnect', reason => {
      logger.info(`Client disconnected: ${socket.id} (${reason})`);
    });
  });
  return io;
}

/** The live list to everyone, and each match to its own room (score / status / minute). */
export async function pushLive(io: Server, live: any[]) {
  const ts = new Date().toISOString();
  io.to('full').emit('matches:live', { data: live, timestamp: ts });
  io.to('teaser').emit('matches:live', teaseDeep({ data: live, timestamp: ts }));
  const rooms = io.sockets.adapter.rooms;
  await perGames(live, b => {
    for (const m of b) {
      if (rooms.has(`match:${m.id}:full`)) io.to(`match:${m.id}:full`).emit('match:live', m);
      if (rooms.has(`match:${m.id}:teaser`)) io.to(`match:${m.id}:teaser`).emit('match:live', teaseDeep({ m }).m);
    }
  });
}
