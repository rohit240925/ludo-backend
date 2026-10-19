import { NextFunction, Request, Response, Router } from 'express';
import { addCoins, getWallet } from '../economy/wallet.js';
import {
  getLeaderboard,
  LEADERBOARD_SCOPES,
  LeaderboardScope,
} from '../economy/leaderboard.js';
import { User } from '../models/User.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { RewardConfig } from '../models/RewardConfig.js';
import { GameRecord } from '../models/GameRecord.js';
import { RoomManager, publicState } from '../realtime/rooms.js';
import { isDbConnected } from '../db.js';
import { mapRouteError } from './errors.js';

/** Admin access is gated by a shared secret. Empty/missing ADMIN_TOKEN disables the APIs. */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    res.status(403).json({ code: 'ADMIN_DISABLED' });
    return;
  }
  if (req.header('x-admin-token') !== token) {
    res.status(403).json({ code: 'FORBIDDEN' });
    return;
  }
  next();
}

export function createAdminRouter(rooms: RoomManager): Router {
  const router = Router();
  router.use(requireAdmin);
  // The whole admin surface (users, ledger, rewards, rooms, matches) needs
  // the database; without it every admin endpoint reports DB_REQUIRED.
  router.use((_req: Request, res: Response, next: NextFunction): void => {
    if (!isDbConnected()) {
      res.status(503).json({ code: 'DB_REQUIRED' });
      return;
    }
    next();
  });

  const onError = (res: Response, e: unknown) => {
    if (!mapRouteError(res, e)) {
      res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
  };

  router.get('/users', async (req: Request, res: Response) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const filter = search
        ? {
            $or: [
              { userId: { $regex: search, $options: 'i' } },
              { displayName: { $regex: search, $options: 'i' } },
            ],
          }
        : {};
      const users = await User.find(filter).sort({ createdAt: -1 }).lean();
      res.json({
        users: users.map((u) => ({
          userId: u.userId,
          displayName: u.displayName,
          coins: u.coins,
          streakDays: u.streakDays,
          lastClaimDate: u.lastClaimDate,
        })),
      });
    } catch (e) {
      onError(res, e);
    }
  });

  router.get('/ledger', async (req: Request, res: Response) => {
    try {
      const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
      if (!userId) {
        res.status(400).json({ code: 'USER_ID_REQUIRED' });
        return;
      }
      const limit = Math.min(
        Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
        500,
      );
      const entries = await LedgerEntry.find({ userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      res.json({
        entries: entries.map((e) => ({
          userId: e.userId,
          delta: e.delta,
          balanceAfter: e.balanceAfter,
          reason: e.reason,
          meta: e.meta ?? null,
          createdAt: e.createdAt,
        })),
      });
    } catch (e) {
      onError(res, e);
    }
  });

  router.post('/grant', async (req: Request, res: Response) => {
    try {
      const { userId, amount, note } = req.body ?? {};
      if (!userId || typeof userId !== 'string') {
        res.status(400).json({ code: 'USER_ID_REQUIRED' });
        return;
      }
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) {
        res.status(400).json({ code: 'INVALID_AMOUNT' });
        return;
      }
      const wallet = await getWallet(userId);
      if (!wallet) {
        res.status(404).json({ code: 'USER_NOT_FOUND' });
        return;
      }
      const reason = amount > 0 ? 'admin_grant' : 'admin_deduct';
      const coins = await addCoins(userId, amount, reason, { note: note ?? null });
      res.json({ userId, coins });
    } catch (e) {
      onError(res, e);
    }
  });

  router.get('/rewards', async (_req: Request, res: Response) => {
    try {
      const rows = await RewardConfig.find().sort({ day: 1 }).lean();
      res.json({ rewards: rows.map((r) => ({ day: r.day, coins: r.coins })) });
    } catch (e) {
      onError(res, e);
    }
  });

  router.put('/rewards', async (req: Request, res: Response) => {
    try {
      const rewards = req.body?.rewards;
      if (!Array.isArray(rewards) || rewards.length === 0) {
        res.status(400).json({ code: 'INVALID_REWARDS' });
        return;
      }
      const seen = new Set<number>();
      const clean: { day: number; coins: number }[] = [];
      for (const r of rewards) {
        if (
          typeof r !== 'object' ||
          r === null ||
          !Number.isInteger(r.day) ||
          r.day < 1 ||
          r.day > 365 ||
          typeof r.coins !== 'number' ||
          !Number.isFinite(r.coins) ||
          r.coins < 0 ||
          seen.has(r.day)
        ) {
          res.status(400).json({ code: 'INVALID_REWARDS' });
          return;
        }
        seen.add(r.day);
        clean.push({ day: r.day, coins: r.coins });
      }
      await RewardConfig.deleteMany({});
      await RewardConfig.insertMany(clean);
      const rows = await RewardConfig.find().sort({ day: 1 }).lean();
      res.json({ rewards: rows.map((r) => ({ day: r.day, coins: r.coins })) });
    } catch (e) {
      onError(res, e);
    }
  });

  router.get('/rooms', (_req: Request, res: Response) => {
    try {
      res.json({ rooms: rooms.allRooms().map(publicState) });
    } catch (e) {
      onError(res, e);
    }
  });

  router.get('/matches', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(
        Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
        500,
      );
      const matches = await GameRecord.find().sort({ createdAt: -1 }).limit(limit).lean();
      res.json({ matches });
    } catch (e) {
      onError(res, e);
    }
  });

  router.get('/leaderboard', async (req: Request, res: Response) => {
    try {
      const scope: LeaderboardScope =
        typeof req.query.scope === 'string' &&
        (LEADERBOARD_SCOPES as readonly string[]).includes(req.query.scope)
          ? (req.query.scope as LeaderboardScope)
          : 'alltime';
      const limit = Math.min(
        Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
        500,
      );
      res.json(await getLeaderboard(scope, limit));
    } catch (e) {
      onError(res, e);
    }
  });

  return router;
}
