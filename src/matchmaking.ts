import { RoomManager } from './realtime/rooms.js';

export type MatchmakingStatus = 'waiting' | 'matched' | 'not_in_queue';

export interface MatchResult {
  status: MatchmakingStatus;
  code?: string;
}

interface QueueEntry {
  userId: string;
  playerName: string;
  joinedAt: number;
}

/** Matched entries expire after this long if nobody polls/joins. */
const MATCH_TTL_MS = 10 * 60 * 1000;

/**
 * Simple 2-player matchmaking queue. The first player waits; when a second
 * distinct player joins, a room is created immediately and both are told
 * the code. Both then join via the normal socket `join_room` flow — the
 * room's `joinRoom` claims the pre-created seat by matching userId, so no
 * duplicate seats appear.
 */
export class MatchmakingQueue {
  private queue: QueueEntry[] = [];
  private matches = new Map<string, { code: string; at: number }>();

  constructor(private rooms: RoomManager) {}

  join(userId: string, playerName: string): MatchResult {
    const hit = this.matches.get(userId);
    if (hit && Date.now() - hit.at < MATCH_TTL_MS) {
      return { status: 'matched', code: hit.code };
    }
    if (hit) this.matches.delete(userId);
    if (this.queue.some((e) => e.userId === userId)) return { status: 'waiting' };

    const waiting = this.queue.find((e) => e.userId !== userId);
    if (waiting) {
      this.queue = this.queue.filter((e) => e.userId !== waiting.userId);
      const room = this.rooms.createRoom(`mm:${waiting.userId}`, waiting.playerName, {
        userId: waiting.userId,
        entryFee: 0,
      });
      const at = Date.now();
      this.matches.set(waiting.userId, { code: room.code, at });
      this.matches.set(userId, { code: room.code, at });
      return { status: 'matched', code: room.code };
    }

    this.queue.push({
      userId,
      playerName: playerName.slice(0, 24) || 'Player',
      joinedAt: Date.now(),
    });
    return { status: 'waiting' };
  }

  status(userId: string): MatchResult {
    const hit = this.matches.get(userId);
    if (hit) {
      if (Date.now() - hit.at < MATCH_TTL_MS) return { status: 'matched', code: hit.code };
      this.matches.delete(userId);
    }
    if (this.queue.some((e) => e.userId === userId)) return { status: 'waiting' };
    return { status: 'not_in_queue' };
  }

  leave(userId: string): void {
    this.queue = this.queue.filter((e) => e.userId !== userId);
    this.matches.delete(userId);
  }

  /** For tests/introspection. */
  queueLength(): number {
    return this.queue.length;
  }
}
