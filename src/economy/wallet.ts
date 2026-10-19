import { isDbConnected } from '../db.js';
import { User, UserDocument } from '../models/User.js';
import { LedgerEntry, LedgerReason } from '../models/LedgerEntry.js';
import { RewardConfig } from '../models/RewardConfig.js';
import { RewardClaim } from '../models/RewardClaim.js';
import { WalletPort } from '../realtime/rooms.js';
import { computeClaim, rewardForDay, todayUTC } from './streak.js';

export interface WalletView {
  userId: string;
  displayName: string;
  coins: number;
  streakDays: number;
  lastClaimDate: string | null;
}

export interface ClaimResult extends WalletView {
  claimed: boolean;
  /** Coins granted by this claim (0 when already claimed). */
  reward: number;
}

function requireDb(): void {
  if (!isDbConnected()) throw new Error('DB_REQUIRED');
}

function toView(u: UserDocument): WalletView {
  return {
    userId: u.userId,
    displayName: u.displayName,
    coins: u.coins,
    streakDays: u.streakDays,
    lastClaimDate: u.lastClaimDate,
  };
}

/** Create the user if needed (updating displayName when provided), return their wallet view. */
export async function identifyUser(
  userId: string,
  displayName?: string,
): Promise<WalletView> {
  requireDb();
  if (!userId || typeof userId !== 'string') throw new Error('USER_ID_REQUIRED');
  const setOnInsert: Record<string, unknown> = {
    userId,
    coins: 0,
    streakDays: 0,
    lastClaimDate: null,
  };
  // displayName must appear under exactly one operator ($set and
  // $setOnInsert on the same path is a ConflictingUpdateOperators error).
  const update: Record<string, unknown> = { $setOnInsert: setOnInsert };
  if (displayName === undefined) {
    setOnInsert.displayName = '';
  } else {
    update.$set = { displayName };
  }
  const doc = await User.findOneAndUpdate({ userId }, update, {
    upsert: true,
    new: true,
  });
  return toView(doc!);
}

/** Wallet view for an existing user, or null when unknown. */
export async function getWallet(userId: string): Promise<WalletView | null> {
  requireDb();
  const doc = await User.findOne({ userId });
  return doc ? toView(doc) : null;
}

/**
 * Add (or subtract) coins atomically. Negative deltas use a guarded
 * findOneAndUpdate so the balance can never go below zero; when the guard
 * fails because of missing funds this throws Error('INSUFFICIENT_COINS').
 * Every non-zero change is recorded in the ledger with the balance after.
 * Returns the new balance.
 */
export async function addCoins(
  userId: string,
  delta: number,
  reason: LedgerReason,
  meta?: unknown,
): Promise<number> {
  requireDb();
  if (!Number.isFinite(delta)) throw new Error('INVALID_AMOUNT');

  if (delta === 0) {
    const existing = await User.findOne({ userId });
    if (!existing) throw new Error('USER_NOT_FOUND');
    return existing.coins;
  }

  const filter =
    delta < 0 ? { userId, coins: { $gte: -delta } } : { userId };
  const doc = await User.findOneAndUpdate(
    filter,
    {
      $inc: { coins: delta },
      $setOnInsert: {
        userId,
        displayName: '',
        streakDays: 0,
        lastClaimDate: null,
      },
    },
    { new: true, upsert: delta > 0 },
  );
  if (!doc) {
    const exists = await User.exists({ userId });
    throw new Error(exists ? 'INSUFFICIENT_COINS' : 'USER_NOT_FOUND');
  }
  await LedgerEntry.create({ userId, delta, balanceAfter: doc.coins, reason, meta });
  return doc.coins;
}

/**
 * Claim the daily reward for a user. Computes the streak from
 * lastClaimDate, grants the configured reward, and stamps the claim.
 */
export async function claimDaily(
  userId: string,
  rewardTable: { day: number; coins: number }[],
): Promise<ClaimResult> {
  requireDb();
  const user = await User.findOne({ userId });
  if (!user) throw new Error('USER_NOT_FOUND');

  const today = todayUTC();
  const { alreadyClaimed, newStreak } = computeClaim(
    user.lastClaimDate,
    user.streakDays,
    today,
  );
  if (alreadyClaimed) {
    return { claimed: false, reward: 0, ...toView(user) };
  }

  const reward = rewardForDay(newStreak, rewardTable);
  const coins = await addCoins(userId, reward, 'daily_reward', {
    streak: newStreak,
    date: today,
  });
  user.lastClaimDate = today;
  user.streakDays = newStreak;
  await user.save();
  // Record into RewardClaim for history unity (unique key = the UTC date, so
  // even a double-claim race can't write two rows). Best-effort: the coins
  // are already granted and the ledger row written; this must not fail the
  // claim.
  await RewardClaim.create({
    userId,
    type: 'daily',
    key: today,
    coins: reward,
    claimedAt: new Date(),
  }).catch(() => {});
  return {
    claimed: true,
    reward,
    userId: user.userId,
    displayName: user.displayName,
    coins,
    streakDays: newStreak,
    lastClaimDate: today,
  };
}

const DEFAULT_REWARDS = [
  { day: 1, coins: 50 },
  { day: 2, coins: 75 },
  { day: 3, coins: 100 },
  { day: 4, coins: 150 },
  { day: 5, coins: 200 },
  { day: 6, coins: 250 },
  { day: 7, coins: 500 },
];

/** Seed the default daily-reward table when RewardConfig is empty. */
export async function ensureDefaultRewards(): Promise<void> {
  requireDb();
  const count = await RewardConfig.countDocuments();
  if (count === 0) {
    await RewardConfig.insertMany(DEFAULT_REWARDS);
  }
}

/** The wallet as seen by the realtime layer (injected into RoomManager). */
export const walletPort: WalletPort = {
  deduct: (userId: string, amount: number, reason: string, meta: unknown) =>
    addCoins(userId, -amount, reason as LedgerReason, meta),
  credit: (userId: string, amount: number, reason: string, meta: unknown) =>
    addCoins(userId, amount, reason as LedgerReason, meta),
};
