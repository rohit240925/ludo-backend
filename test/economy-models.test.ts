import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../src/models/User.js';
import { LedgerEntry } from '../src/models/LedgerEntry.js';
import { RewardConfig } from '../src/models/RewardConfig.js';

/**
 * Schema validation tests. These run WITHOUT a MongoDB connection —
 * mongoose validate() is pure and local, which is exactly what we want
 * since the database is optional in this project.
 */
describe('User model', () => {
  it('applies defaults for a fresh user', async () => {
    const doc = new User({ userId: 'u1', displayName: 'Asha' });
    await doc.validate();
    assert.equal(doc.coins, 0);
    assert.equal(doc.streakDays, 0);
    assert.equal(doc.lastClaimDate, null);
  });

  it('requires a userId', async () => {
    const doc = new User({ displayName: 'NoId' });
    await assert.rejects(() => doc.validate(), /userId/);
  });

  it('rejects a negative coin balance', async () => {
    const doc = new User({ userId: 'u2', coins: -5 });
    await assert.rejects(() => doc.validate(), /coins/);
  });
});

describe('LedgerEntry model', () => {
  it('validates a complete ledger entry', async () => {
    const doc = new LedgerEntry({
      userId: 'u1',
      delta: 50,
      balanceAfter: 150,
      reason: 'daily_reward',
      meta: { streak: 1, date: '2026-10-18' },
    });
    await doc.validate();
  });

  it('rejects an unknown reason', async () => {
    const doc = new LedgerEntry({
      userId: 'u1',
      delta: 10,
      balanceAfter: 10,
      reason: 'lottery',
    });
    await assert.rejects(() => doc.validate(), /reason/);
  });

  it('accepts every documented reason', async () => {
    for (const reason of [
      'daily_reward',
      'room_entry',
      'room_entry_refund',
      'room_win',
      'admin_grant',
      'admin_deduct',
    ]) {
      const doc = new LedgerEntry({ userId: 'u1', delta: 1, balanceAfter: 1, reason });
      await doc.validate();
    }
  });

  it('requires userId, delta, balanceAfter and reason', async () => {
    await assert.rejects(() => new LedgerEntry({}).validate(), /userId/);
  });
});

describe('RewardConfig model', () => {
  it('validates a reward row', async () => {
    const doc = new RewardConfig({ day: 7, coins: 500 });
    await doc.validate();
  });

  it('rejects negative coins', async () => {
    const doc = new RewardConfig({ day: 1, coins: -10 });
    await assert.rejects(() => doc.validate(), /coins/);
  });

  it('requires day and coins', async () => {
    await assert.rejects(() => new RewardConfig({ day: 3 }).validate(), /coins/);
    await assert.rejects(() => new RewardConfig({ coins: 3 }).validate(), /day/);
  });
});
