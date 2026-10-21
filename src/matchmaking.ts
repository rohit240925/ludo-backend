import { RoomManager } from './realtime/rooms.js';

export type MatchmakingStatus = 'waiting' | 'matched' | 'not_in_queue';

export interface MatchResult {
  status: MatchmakingStatus;
  code?: string;
  /** Bucket the player queued for (echoed so clients can show it). */
  playerCount?: number;
  entryFee?: number;
}

export interface MatchmakingOptions {
  /** Seats to fill before a room is created: 2 or 4. Default 2. */
  playerCount?: number;
  /** Entry fee in coins for the created room. Default 0 (free). */
  entryFee?: number;
}

interface QueueEntry {
  userId: string;
  playerName: string;
  playerCount: number;
  entryFee: number;
  joinedAt: number;
}

/** Matched entries expire after this long if nobody polls/joins. */
const MATCH_TTL_MS = 10 * 60 * 1000;

function bucketKey(playerCount: number, entryFee: number): string {
  return `${playerCount}:${entryFee}`;
}

function normalizePlayerCount(v: unknown): number {
  return v === 4 ? 4 : 2;
}

function normalizeEntryFee(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * Matchmaking queue, bucketed by (playerCount, entryFee). Players wait in
 * their bucket; when it fills to `playerCount`, a room is created with that
 * many seats and the bucket's entry fee, and every member can read the code
 * from `status`. All members then join via the normal socket `join_room`
 * flow — `joinRoom` claims the pre-created host seat by matching userId,
 * and the room auto-starts once every expected seat is filled and
 * connected (see `expectedPlayers` in rooms.ts / socket.ts).
 */
export class MatchmakingQueue {
  private buckets = new Map<string, QueueEntry[]>();
  private matches = new Map<string, { code: string; at: number }>();

  constructor(private rooms: RoomManager) {}

  join(userId: string, playerName: string, opts: MatchmakingOptions = {}): MatchResult {
    const playerCount = normalizePlayerCount(opts.playerCount);
    const entryFee = normalizeEntryFee(opts.entryFee);

    const hit = this.matches.get(userId);
    if (hit && Date.now() - hit.at < MATCH_TTL_MS) {
      return { status: 'matched', code: hit.code, playerCount, entryFee };
    }
    if (hit) this.matches.delete(userId);
    if (this.findEntry(userId)) return { status: 'waiting', playerCount, entryFee };

    const key = bucketKey(playerCount, entryFee);
    const bucket = this.buckets.get(key) ?? [];
    bucket.push({
      userId,
      playerName: playerName.slice(0, 24) || 'Player',
      playerCount,
      entryFee,
      joinedAt: Date.now(),
    });
    this.buckets.set(key, bucket);

    if (bucket.length < playerCount) return { status: 'waiting', playerCount, entryFee };

    // Bucket full — create the room. The longest-waiting player hosts.
    const group = bucket.splice(0, playerCount);
    if (bucket.length === 0) this.buckets.delete(key);
    const host = group[0];
    const room = this.rooms.createRoom(`mm:${host.userId}`, host.playerName, {
      userId: host.userId,
      entryFee,
      expectedPlayers: playerCount,
    });
    // The host seat is a reservation until the host's socket claims it via
    // join_room; mark it not-connected so the room cannot auto-start early.
    room.players[0].connected = false;
    const at = Date.now();
    for (const member of group) {
      this.matches.set(member.userId, { code: room.code, at });
    }
    return { status: 'matched', code: room.code, playerCount, entryFee };
  }

  status(userId: string): MatchResult {
    const hit = this.matches.get(userId);
    if (hit) {
      if (Date.now() - hit.at < MATCH_TTL_MS) return { status: 'matched', code: hit.code };
      this.matches.delete(userId);
    }
    const entry = this.findEntry(userId);
    if (entry) {
      return { status: 'waiting', playerCount: entry.playerCount, entryFee: entry.entryFee };
    }
    return { status: 'not_in_queue' };
  }

  leave(userId: string): void {
    for (const [key, bucket] of this.buckets) {
      const next = bucket.filter((e) => e.userId !== userId);
      if (next.length === 0) this.buckets.delete(key);
      else if (next.length !== bucket.length) this.buckets.set(key, next);
    }
    this.matches.delete(userId);
  }

  private findEntry(userId: string): QueueEntry | undefined {
    for (const bucket of this.buckets.values()) {
      const e = bucket.find((x) => x.userId === userId);
      if (e) return e;
    }
    return undefined;
  }

  /** For tests/introspection: total players waiting across all buckets. */
  queueLength(): number {
    let n = 0;
    for (const bucket of this.buckets.values()) n += bucket.length;
    return n;
  }
}
