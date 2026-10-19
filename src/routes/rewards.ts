import { Request, Response, Router } from 'express';
import { isDbConnected } from '../db.js';
import { addCoins } from '../economy/wallet.js';
import { DEFAULT_RULES } from '../engine/rules.js';
import { LedgerEntry, LedgerReason } from '../models/LedgerEntry.js';
import { RewardClaim } from '../models/RewardClaim.js';
import { mapRouteError } from './errors.js';

export const rewardsRouter = Router();

/** Ledger reason -> friendly reward type for the history endpoint. */
function reasonToType(reason: LedgerReason): string {
  switch (reason) {
    case 'daily_reward':
      return 'daily';
    case 'victory_bonus':
      return 'victory';
    case 'room_win':
      return 'room_win';
    default:
      return reason;
  }
}

/**
 * Claim a victory bonus: credits victoryBonusCoins to the winner's wallet.
 * Anti-duplicate: (userId, 'victory', matchCode) is unique — a second claim
 * for the same match answers 409 ALREADY_CLAIMED and credits nothing.
 */
rewardsRouter.post('/api/rewards/claim', async (req: Request, res: Response) => {
  try {
    const { userId, type, matchCode } = req.body ?? {};
    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ code: 'USER_ID_REQUIRED' });
      return;
    }
    if (type !== 'victory') {
      res.status(400).json({ code: 'INVALID_REWARD_TYPE' });
      return;
    }
    if (!matchCode || typeof matchCode !== 'string') {
      res.status(400).json({ code: 'MATCH_CODE_REQUIRED' });
      return;
    }
    if (!isDbConnected()) throw new Error('DB_REQUIRED');

    const coins = DEFAULT_RULES.victoryBonusCoins;
    // The unique index is the atomic anti-duplicate guard: exactly one claim
    // row can exist per (user, type, match), even under races.
    try {
      await RewardClaim.create({
        userId,
        type: 'victory',
        key: matchCode,
        coins,
        claimedAt: new Date(),
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        res.status(409).json({ code: 'ALREADY_CLAIMED' });
        return;
      }
      throw e;
    }
    let balance: number;
    try {
      balance = await addCoins(userId, coins, 'victory_bonus', { matchCode });
    } catch (e) {
      // Credit failed after reserving the claim: release the reservation so a
      // retry is possible instead of stranding the user at 409.
      await RewardClaim.deleteOne({ userId, type: 'victory', key: matchCode }).catch(
        () => {},
      );
      throw e;
    }
    res.json({ claimed: true, type: 'victory', coins, balance });
  } catch (e) {
    if (!mapRouteError(res, e)) {
      res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
  }
});

/** Reward history for a user, newest first: [{ type, coins, at }]. */
rewardsRouter.get('/api/rewards/history/:userId', async (req: Request, res: Response) => {
  try {
    if (!isDbConnected()) throw new Error('DB_REQUIRED');
    const entries = await LedgerEntry.find({
      userId: req.params.userId,
      delta: { $gt: 0 },
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({
      rewards: entries.map((e) => ({
        type: reasonToType(e.reason),
        coins: e.delta,
        at: e.createdAt,
      })),
    });
  } catch (e) {
    if (!mapRouteError(res, e)) {
      res.status(500).json({ code: 'INTERNAL_ERROR' });
    }
  }
});
