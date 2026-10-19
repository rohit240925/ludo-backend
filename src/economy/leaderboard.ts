import { isDbConnected } from '../db.js';
import {
  MatchStats,
  LeaderboardScope,
  LEADERBOARD_SCOPES,
} from '../models/MatchStats.js';
import { User } from '../models/User.js';
import { Room } from '../realtime/rooms.js';
import { RulesConfig } from '../engine/rules.js';

export { LEADERBOARD_SCOPES };
export type { LeaderboardScope };

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  matchesPlayed: number;
  matchesWon: number;
  /** Win percentage, 0-100 rounded to one decimal. */
  winPct: number;
  points: number;
}

export interface LeaderboardView {
  scope: LeaderboardScope;
  period: string;
  /** ISO timestamp of the next period boundary, or null for alltime. */
  resetAt: string | null;
  entries: LeaderboardEntry[];
}

/** Period key for a scope at a UTC instant. */
export function periodFor(scope: LeaderboardScope, d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  switch (scope) {
    case 'daily':
      return `${y}-${m}-${day}`;
    case 'monthly':
      return `${y}-${m}`;
    case 'alltime':
      return 'all';
    case 'weekly': {
      // ISO-8601 week: week 1 contains the year's first Thursday.
      const t = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
      const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0..Sun=6
      t.setUTCDate(t.getUTCDate() - dayNum + 3); // shift to Thursday
      const weekYear = t.getUTCFullYear();
      const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
      const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
      firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
      const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / 604800000);
      return `${weekYear}-W${String(week).padStart(2, '0')}`;
    }
  }
}

/** Next period boundary (UTC) for a scope, or null when the scope never resets. */
export function resetAtFor(scope: LeaderboardScope, d: Date): string | null {
  switch (scope) {
    case 'alltime':
      return null;
    case 'daily': {
      const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
      return n.toISOString();
    }
    case 'weekly': {
      // Next Monday 00:00 UTC.
      const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
      const n = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (7 - dayNum)),
      );
      return n.toISOString();
    }
    case 'monthly': {
      const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      return n.toISOString();
    }
  }
}

function winPctOf(played: number, won: number): number {
  if (played <= 0) return 0;
  return Math.round((won / played) * 1000) / 10;
}

/**
 * Tie-break order: points DESC, matchesWon DESC, win% DESC, userId ASC.
 * userId ASC is the final deterministic tie-break.
 */
function compareStats(
  a: { points: number; matchesWon: number; matchesPlayed: number; userId: string },
  b: { points: number; matchesWon: number; matchesPlayed: number; userId: string },
): number {
  if (b.points !== a.points) return b.points - a.points;
  if (b.matchesWon !== a.matchesWon) return b.matchesWon - a.matchesWon;
  const aw = winPctOf(a.matchesPlayed, a.matchesWon);
  const bw = winPctOf(b.matchesPlayed, b.matchesWon);
  if (bw !== aw) return bw - aw;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/** Lean shape of a MatchStats row (what .lean() returns). */
interface StatsRow {
  userId: string;
  displayName: string;
  matchesPlayed: number;
  matchesWon: number;
  points: number;
}

function toEntry(doc: StatsRow): Omit<LeaderboardEntry, 'rank'> {
  return {
    userId: doc.userId,
    displayName: doc.displayName,
    matchesPlayed: doc.matchesPlayed,
    matchesWon: doc.matchesWon,
    winPct: winPctOf(doc.matchesPlayed, doc.matchesWon),
    points: doc.points,
  };
}

/** Full sorted entry list for a scope's current period (rank assigned). */
async function rankedEntries(scope: LeaderboardScope): Promise<LeaderboardEntry[]> {
  if (!isDbConnected()) throw new Error('DB_REQUIRED');
  const period = periodFor(scope, new Date());
  const docs = await MatchStats.find({ scope, period }).lean();
  const sorted = docs.map(toEntry).sort(compareStats);
  return sorted.map((e, i) => ({ ...e, rank: i + 1 }));
}

export async function getLeaderboard(
  scope: LeaderboardScope,
  limit: number,
): Promise<LeaderboardView> {
  const now = new Date();
  const entries = await rankedEntries(scope);
  return {
    scope,
    period: periodFor(scope, now),
    resetAt: resetAtFor(scope, now),
    entries: entries.slice(0, limit),
  };
}

/** Global-ranked entries for an arbitrary set of users (friends board). */
export async function getFriendsBoard(
  scope: LeaderboardScope,
  userIds: string[],
): Promise<LeaderboardView> {
  const now = new Date();
  const wanted = new Set(userIds);
  const entries = (await rankedEntries(scope)).filter((e) => wanted.has(e.userId));
  return {
    scope,
    period: periodFor(scope, now),
    resetAt: resetAtFor(scope, now),
    entries,
  };
}

export interface ProfileView {
  userId: string;
  displayName: string;
  coins: number;
  streakDays: number;
  /** All-time global rank, or null when the user has no recorded matches. */
  rank: number | null;
  matchesPlayed: number;
  matchesWon: number;
  winPct: number;
  points: number;
}

export async function getProfile(userId: string): Promise<ProfileView> {
  if (!isDbConnected()) throw new Error('DB_REQUIRED');
  const user = await User.findOne({ userId }).lean();
  if (!user) throw new Error('USER_NOT_FOUND');
  const stats = await MatchStats.findOne({
    userId,
    scope: 'alltime',
    period: 'all',
  }).lean();
  let rank: number | null = null;
  let matchesPlayed = 0;
  let matchesWon = 0;
  let points = 0;
  if (stats) {
    matchesPlayed = stats.matchesPlayed;
    matchesWon = stats.matchesWon;
    points = stats.points;
    rank = (await rankedEntries('alltime')).findIndex((e) => e.userId === userId) + 1;
    if (rank === 0) rank = null;
  }
  return {
    userId,
    displayName: user.displayName,
    coins: user.coins,
    streakDays: user.streakDays,
    rank,
    matchesPlayed,
    matchesWon,
    winPct: winPctOf(matchesPlayed, matchesWon),
    points,
  };
}

/**
 * Fold one finished match into every leaderboard scope. Called from the
 * game_over persist hook; silently skips when there is no database, and
 * skips seats without a linked userId.
 */
export async function recordMatchResult(room: Room, rules: RulesConfig): Promise<void> {
  if (!isDbConnected()) return;
  const now = new Date();
  const scopes: LeaderboardScope[] = [...LEADERBOARD_SCOPES];
  const ops: unknown[] = [];
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (!p.userId) continue;
    const won = room.winner === i;
    for (const scope of scopes) {
      const period = periodFor(scope, now);
      ops.push({
        updateOne: {
          filter: { userId: p.userId, scope, period },
          update: {
            $set: { displayName: p.name, updatedAt: now },
            $setOnInsert: { userId: p.userId, scope, period },
            $inc: {
              matchesPlayed: 1,
              matchesWon: won ? 1 : 0,
              matchesLost: won ? 0 : 1,
              points: won ? rules.winPoints : rules.lossPoints,
            },
          },
          upsert: true,
        },
      });
    }
  }
  if (ops.length > 0) {
    await MatchStats.bulkWrite(ops as Parameters<typeof MatchStats.bulkWrite>[0]);
  }
}
