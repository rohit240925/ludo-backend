import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { DiceFn } from './engine/ludo.js';
import { DEFAULT_RULES, RulesConfig } from './engine/rules.js';
import { config } from './config.js';
import { connectDb, isDbConnected } from './db.js';
import { recordMatchResult } from './economy/leaderboard.js';
import { GameRecord } from './models/GameRecord.js';
import { Room, RoomManager, publicState } from './realtime/rooms.js';
import { attachSocket } from './realtime/socket.js';
import { economyRouter } from './routes/economy.js';
import { leaderboardRouter } from './routes/leaderboard.js';
import { rewardsRouter } from './routes/rewards.js';
import { createAdminRouter } from './routes/admin.js';
import { MatchmakingQueue } from './matchmaking.js';
import { walletPort } from './economy/wallet.js';

export interface ServerOptions {
  port?: number;
  /** Inject deterministic dice (used by tests). Defaults to Math.random. */
  diceFactory?: () => DiceFn;
  /** Override game rules (used by tests for short turn timers). */
  rules?: RulesConfig;
}

export function buildServer(opts: ServerOptions = {}) {
  const app = express();
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin }));
  app.use(express.json());

  const rules = opts.rules ?? DEFAULT_RULES;
  const rooms = new RoomManager(opts.diceFactory, walletPort, rules);
  const matchmaking = new MatchmakingQueue(rooms);

  app.use(economyRouter);
  app.use(leaderboardRouter);
  app.use(rewardsRouter);
  app.use('/api/admin', createAdminRouter(rooms));

  // -- matchmaking ------------------------------------------------------------
  app.post('/api/matchmaking/join', (req, res) => {
    const { userId, playerName } = req.body ?? {};
    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ code: 'USER_ID_REQUIRED' });
      return;
    }
    res.json(
      matchmaking.join(userId, typeof playerName === 'string' ? playerName : 'Player'),
    );
  });
  app.get('/api/matchmaking/status/:userId', (req, res) => {
    res.json(matchmaking.status(req.params.userId));
  });
  app.post('/api/matchmaking/leave', (req, res) => {
    const { userId } = req.body ?? {};
    if (typeof userId === 'string') matchmaking.leave(userId);
    res.json({ ok: true });
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      rooms: rooms.roomCount(),
      db: isDbConnected(),
    });
  });

  app.get('/api/rooms/:code', (req, res) => {
    const room = rooms.get(req.params.code);
    if (!room) {
      res.status(404).json({ error: 'ROOM_NOT_FOUND' });
      return;
    }
    const s = publicState(room);
    res.json({
      code: s.code,
      status: s.status,
      playerCount: s.players.length,
      players: s.players.map((p) => p.name),
    });
  });

  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: config.corsOrigin } });

  const persist = async (room: Room): Promise<void> => {
    if (!isDbConnected()) return;
    try {
      await GameRecord.create({
        code: room.code,
        numPlayers: room.players.length,
        playerNames: room.players.map((p) => p.name),
        winner: room.winner,
        moves: room.moves,
        startedAt: new Date(room.createdAt),
        endedAt: new Date(),
      });
    } catch (e) {
      console.warn('[db] failed to persist game record:', (e as Error).message);
    }
    // Fold the result into the leaderboards (all scopes). Skips silently
    // when a seat has no linked userId; never breaks game_over.
    try {
      await recordMatchResult(room, rooms.rules);
    } catch (e) {
      console.warn('[db] failed to record leaderboard stats:', (e as Error).message);
    }
  };

  attachSocket(io, rooms, persist);
  return { app, httpServer, io, rooms, matchmaking };
}

export async function startServer(opts: ServerOptions = {}) {
  const port = opts.port ?? config.port;
  const { httpServer } = buildServer(opts);
  await connectDb();
  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.log(
    `[ludo] listening on :${port} (persistence: ${isDbConnected() ? 'mongodb' : 'disabled'})`,
  );
  return httpServer;
}

// `node dist/src/server.js` -> run the server directly.
if (process.argv[1]?.endsWith('server.js')) {
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
