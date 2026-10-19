/**
 * Daily-streak logic. Pure functions with no DB access so they are fully
 * unit-testable. All dates are YYYY-MM-DD strings in UTC.
 */

export function todayUTC(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function yesterdayUTC(today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export interface ClaimComputation {
  alreadyClaimed: boolean;
  /** Streak that applies after this claim (or the unchanged streak when already claimed). */
  newStreak: number;
}

/**
 * Decide the outcome of a daily claim given the user's last claim date.
 * - lastClaimDate === today      -> already claimed, streak unchanged
 * - lastClaimDate === yesterday  -> streak continues (streakDays + 1)
 * - anything else (incl. null)   -> streak resets to 1
 */
export function computeClaim(
  lastClaimDate: string | null,
  streakDays: number,
  today: string,
): ClaimComputation {
  if (lastClaimDate === today) {
    return { alreadyClaimed: true, newStreak: streakDays };
  }
  if (lastClaimDate === yesterdayUTC(today)) {
    return { alreadyClaimed: false, newStreak: streakDays + 1 };
  }
  return { alreadyClaimed: false, newStreak: 1 };
}

/**
 * Reward for a streak from the config table: the row with the largest
 * `day` that is still <= streak. Streaks beyond the max configured day
 * keep earning the top reward. Returns 0 when no row qualifies.
 * Order-independent: works on unsorted tables too.
 */
export function rewardForDay(
  streak: number,
  table: { day: number; coins: number }[],
): number {
  let bestDay = -Infinity;
  let reward = 0;
  for (const row of table) {
    if (row.day <= streak && row.day > bestDay) {
      bestDay = row.day;
      reward = row.coins;
    }
  }
  return reward;
}
