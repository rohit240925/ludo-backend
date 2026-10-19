import { Request, Response, Router } from 'express';
import {
  claimDaily,
  ensureDefaultRewards,
  getWallet,
  identifyUser,
} from '../economy/wallet.js';
import { RewardConfig } from '../models/RewardConfig.js';
import { mapRouteError } from './errors.js';

export const economyRouter = Router();

economyRouter.post('/api/users/identify', async (req: Request, res: Response) => {
  try {
    const { userId, displayName } = req.body ?? {};
    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ code: 'USER_ID_REQUIRED' });
      return;
    }
    res.json(await identifyUser(userId, displayName));
  } catch (e) {
    if (!mapRouteError(res, e)) {
      res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
  }
});

economyRouter.get('/api/wallet/:userId', async (req: Request, res: Response) => {
  try {
    const wallet = await getWallet(req.params.userId);
    if (!wallet) {
      res.status(404).json({ code: 'USER_NOT_FOUND' });
      return;
    }
    res.json(wallet);
  } catch (e) {
    if (!mapRouteError(res, e)) {
      res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
  }
});

economyRouter.post(
  '/api/wallet/:userId/claim-daily',
  async (req: Request, res: Response) => {
    try {
      await ensureDefaultRewards();
      const rows = await RewardConfig.find().sort({ day: 1 }).lean();
      const result = await claimDaily(
        req.params.userId,
        rows.map((r) => ({ day: r.day, coins: r.coins })),
      );
      res.json(result);
    } catch (e) {
      if (!mapRouteError(res, e)) {
        res.status(500).json({ code: 'INTERNAL_ERROR' });
      }
    }
  },
);
