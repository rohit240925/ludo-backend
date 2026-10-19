import { Request, Response, Router } from 'express';
import {
  getFriendsBoard,
  getLeaderboard,
  getProfile,
  LEADERBOARD_SCOPES,
  LeaderboardScope,
} from '../economy/leaderboard.js';
import { mapRouteError } from './errors.js';

export const leaderboardRouter = Router();

function parseScope(q: unknown): LeaderboardScope {
  return typeof q === 'string' && (LEADERBOARD_SCOPES as readonly string[]).includes(q)
    ? (q as LeaderboardScope)
    : 'alltime';
}

function parseLimit(q: unknown): number {
  const n = Number.parseInt(String(q ?? '50'), 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : 50, 1), 500);
}

leaderboardRouter.get('/api/leaderboard', async (req: Request, res: Response) => {
  try {
    res.json(await getLeaderboard(parseScope(req.query.scope), parseLimit(req.query.limit)));
  } catch (e) {
    if (!mapRouteError(res, e)) {
      res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
  }
});

leaderboardRouter.get('/api/leaderboard/friends', async (req: Request, res: Response) => {
  try {
    const raw = typeof req.query.userIds === 'string' ? req.query.userIds : '';
    const userIds = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    res.json(await getFriendsBoard(parseScope(req.query.scope), userIds));
  } catch (e) {
    if (!mapRouteError(res, e)) {
      res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
  }
});

leaderboardRouter.get('/api/profile/:userId', async (req: Request, res: Response) => {
  try {
    res.json(await getProfile(req.params.userId));
  } catch (e) {
    if (!mapRouteError(res, e)) {
      res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
  }
});
