import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeClaim,
  rewardForDay,
  todayUTC,
  yesterdayUTC,
} from '../src/economy/streak.js';

describe('streak helpers', () => {
  it('todayUTC returns YYYY-MM-DD in UTC', () => {
    assert.match(todayUTC(new Date('2026-10-18T05:30:00Z')), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(todayUTC(new Date('2026-10-18T23:59:59Z')), '2026-10-18');
    assert.equal(todayUTC(new Date('2026-10-19T00:00:01Z')), '2026-10-19');
  });

  it('yesterdayUTC handles month and year boundaries', () => {
    assert.equal(yesterdayUTC('2026-10-18'), '2026-10-17');
    assert.equal(yesterdayUTC('2026-11-01'), '2026-10-31');
    assert.equal(yesterdayUTC('2026-01-01'), '2025-12-31');
    assert.equal(yesterdayUTC('2024-03-01'), '2024-02-29'); // leap year
    assert.equal(yesterdayUTC('2025-03-01'), '2025-02-28');
  });
});

describe('computeClaim', () => {
  it('same-day claim is already claimed, streak unchanged', () => {
    const r = computeClaim('2026-10-18', 4, '2026-10-18');
    assert.equal(r.alreadyClaimed, true);
    assert.equal(r.newStreak, 4);
  });

  it('consecutive day continues the streak', () => {
    const r = computeClaim('2026-10-17', 4, '2026-10-18');
    assert.equal(r.alreadyClaimed, false);
    assert.equal(r.newStreak, 5);
  });

  it('a missed day resets the streak to 1', () => {
    const r = computeClaim('2026-10-15', 9, '2026-10-18');
    assert.equal(r.alreadyClaimed, false);
    assert.equal(r.newStreak, 1);
  });

  it('first ever claim (null) starts the streak at 1', () => {
    const r = computeClaim(null, 0, '2026-10-18');
    assert.equal(r.alreadyClaimed, false);
    assert.equal(r.newStreak, 1);
  });

  it('consecutive claim across a month boundary', () => {
    const r = computeClaim('2026-10-31', 2, '2026-11-01');
    assert.equal(r.alreadyClaimed, false);
    assert.equal(r.newStreak, 3);
  });

  it('consecutive claim across a year boundary', () => {
    const r = computeClaim('2025-12-31', 7, '2026-01-01');
    assert.equal(r.alreadyClaimed, false);
    assert.equal(r.newStreak, 8);
  });
});

describe('rewardForDay', () => {
  const table = [
    { day: 1, coins: 50 },
    { day: 2, coins: 75 },
    { day: 3, coins: 100 },
    { day: 7, coins: 500 },
  ];

  it('picks the largest day <= streak', () => {
    assert.equal(rewardForDay(1, table), 50);
    assert.equal(rewardForDay(2, table), 75);
    assert.equal(rewardForDay(4, table), 100); // day 4..6 fall back to day-3 row
    assert.equal(rewardForDay(6, table), 100);
    assert.equal(rewardForDay(7, table), 500);
  });

  it('streaks beyond the max configured day keep the top reward', () => {
    assert.equal(rewardForDay(30, table), 500);
    assert.equal(rewardForDay(365, table), 500);
  });

  it('returns 0 when no row qualifies or the table is empty', () => {
    assert.equal(rewardForDay(0, table), 0);
    assert.equal(rewardForDay(1, []), 0);
  });

  it('works with an unsorted table', () => {
    const shuffled = [...table].reverse();
    assert.equal(rewardForDay(5, shuffled), 100);
  });
});
