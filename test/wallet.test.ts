import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  addCoins,
  claimDaily,
  ensureDefaultRewards,
  getWallet,
  identifyUser,
} from '../src/economy/wallet.js';
import { User } from '../src/models/User.js';
import { LedgerEntry } from '../src/models/LedgerEntry.js';
import { RewardConfig } from '../src/models/RewardConfig.js';
import { todayUTC, yesterdayUTC } from '../src/economy/streak.js';

function daysAgo(n: number): string {
  const [y, m, d] = todayUTC().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

describe('wallet (live DB)', () => {
  let mongod: MongoMemoryServer;

  before(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  it('identifyUser upserts and returns the wallet view', async () => {
    const w1 = await identifyUser('u1', 'Asha');
    assert.deepEqual(w1, {
      userId: 'u1',
      displayName: 'Asha',
      coins: 0,
      streakDays: 0,
      lastClaimDate: null,
    });
    // Re-identify updates the display name without touching the balance.
    await addCoins('u1', 25, 'admin_grant');
    const w2 = await identifyUser('u1', 'Asha Devi');
    assert.equal(w2.displayName, 'Asha Devi');
    assert.equal(w2.coins, 25);
  });

  it('getWallet returns null for an unknown user', async () => {
    assert.equal(await getWallet('nobody'), null);
  });

  it('grants and deducts with ledger entries and correct balanceAfter', async () => {
    await identifyUser('u2', 'Bala');
    assert.equal(await addCoins('u2', 100, 'admin_grant', { note: 'test' }), 100);
    assert.equal(await addCoins('u2', -30, 'admin_deduct'), 70);

    const entries = await LedgerEntry.find({ userId: 'u2' }).sort({ createdAt: 1 });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].delta, 100);
    assert.equal(entries[0].balanceAfter, 100);
    assert.equal(entries[0].reason, 'admin_grant');
    assert.equal(entries[1].delta, -30);
    assert.equal(entries[1].balanceAfter, 70);
    assert.equal(entries[1].reason, 'admin_deduct');

    assert.equal((await getWallet('u2'))!.coins, 70);
  });

  it('rejects deductions that exceed the balance without recording a ledger entry', async () => {
    await identifyUser('u3', 'Chandra');
    await addCoins('u3', 40, 'admin_grant');
    const before = await LedgerEntry.countDocuments({ userId: 'u3' });
    await assert.rejects(
      () => addCoins('u3', -41, 'admin_deduct'),
      (e: Error) => e.message === 'INSUFFICIENT_COINS',
    );
    assert.equal((await getWallet('u3'))!.coins, 40);
    assert.equal(await LedgerEntry.countDocuments({ userId: 'u3' }), before);
  });

  it('ensureDefaultRewards seeds the default table exactly once', async () => {
    await RewardConfig.deleteMany({});
    await ensureDefaultRewards();
    await ensureDefaultRewards(); // second call is a no-op
    const rows = await RewardConfig.find().sort({ day: 1 });
    assert.deepEqual(
      rows.map((r) => ({ day: r.day, coins: r.coins })),
      [
        { day: 1, coins: 50 },
        { day: 2, coins: 75 },
        { day: 3, coins: 100 },
        { day: 4, coins: 150 },
        { day: 5, coins: 200 },
        { day: 6, coins: 250 },
        { day: 7, coins: 500 },
      ],
    );
  });

  it('claim-daily progresses the streak across simulated days', async () => {
    await RewardConfig.deleteMany({});
    await ensureDefaultRewards();
    await identifyUser('u4', 'Divya');

    // Day 1: first claim.
    const c1 = await claimDaily('u4', (await RewardConfig.find().sort({ day: 1 })).map((r) => ({ day: r.day, coins: r.coins })));
    assert.equal(c1.claimed, true);
    assert.equal(c1.streakDays, 1);
    assert.equal(c1.reward, 50);
    assert.equal(c1.coins, 50);
    assert.equal(c1.lastClaimDate, todayUTC());

    // Same day again: already claimed.
    const c1b = await claimDaily('u4', []);
    assert.equal(c1b.claimed, false);
    assert.equal(c1b.streakDays, 1);
    assert.equal(c1b.coins, 50);

    // Simulate a consecutive day: streak continues.
    await User.updateOne(
      { userId: 'u4' },
      { lastClaimDate: yesterdayUTC(todayUTC()), streakDays: 1 },
    );
    const c2 = await claimDaily('u4', (await RewardConfig.find().sort({ day: 1 })).map((r) => ({ day: r.day, coins: r.coins })));
    assert.equal(c2.claimed, true);
    assert.equal(c2.streakDays, 2);
    assert.equal(c2.reward, 75);
    assert.equal(c2.coins, 125);

    // Simulate a missed day: streak resets to 1.
    await User.updateOne(
      { userId: 'u4' },
      { lastClaimDate: daysAgo(3), streakDays: 9 },
    );
    const c3 = await claimDaily('u4', (await RewardConfig.find().sort({ day: 1 })).map((r) => ({ day: r.day, coins: r.coins })));
    assert.equal(c3.claimed, true);
    assert.equal(c3.streakDays, 1);
    assert.equal(c3.reward, 50);
    assert.equal(c3.coins, 175);

    // Ledger recorded all three daily rewards.
    const rewards = await LedgerEntry.find({ userId: 'u4', reason: 'daily_reward' }).sort({
      createdAt: 1,
    });
    assert.equal(rewards.length, 3);
    assert.deepEqual(rewards.map((r) => r.delta), [50, 75, 50]);
    assert.deepEqual(rewards.map((r) => r.meta).map((m: any) => m.streak), [1, 2, 1]);
  });

  it('claimDaily on an unknown user throws USER_NOT_FOUND', async () => {
    await assert.rejects(
      () => claimDaily('ghost', [{ day: 1, coins: 50 }]),
      (e: Error) => e.message === 'USER_NOT_FOUND',
    );
  });
});
