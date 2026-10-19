import { DiceFn, GameSnapshot, LudoGame } from '../engine/ludo.js';
import { DEFAULT_RULES, RulesConfig } from '../engine/rules.js';

export interface RoomPlayer {
  /** Socket id; stable for the life of one connection. */
  id: string;
  name: string;
  connected: boolean;
  /** Virtual-coin account linked to this seat (for entry fees / winnings). */
  userId?: string;
  /**
   * Lives remaining. A missed server-side turn timer costs exactly one life
   * (floored at zero); at zero the seat is eliminated.
   */
  lives: number;
  /** True once lives hit zero — the seat is out of the game. */
  eliminated: boolean;
}

export type RoomStatus = 'waiting' | 'playing' | 'finished';

/** Which half of the turn the server clock is currently measuring. */
export type TurnPhase = 'roll' | 'move';

export interface StoredMove {
  player: number;
  tokenIndex: number;
  roll: number;
  from: number;
  to: number;
  captured: number;
  at: string;
}

export interface Room {
  code: string;
  /** Positional: index === engine player id. Never reordered mid-game. */
  players: RoomPlayer[];
  game: LudoGame | null;
  status: RoomStatus;
  createdAt: number;
  moves: StoredMove[];
  winner: number | null;
  /** Coins each player pays to join the game. 0 = free. */
  entryFee: number;
  // --- server-authoritative turn clock (see docs/ARCHITECTURE.md) ---
  /** Current phase being timed, or null when no clock is running. */
  phase: TurnPhase | null;
  /** Epoch ms on the SERVER clock when the current phase expires. */
  deadlineAt: number | null;
  /** Incremented on every turn/phase change; stale timeout callbacks are ignored. */
  turnNonce: number;
  /** Exactly-once guard: a timeout applies at most once per nonce. */
  timeoutFired: boolean;
}

/** What clients are allowed to see. */
export interface RoomState {
  code: string;
  status: RoomStatus;
  players: { name: string; connected: boolean; lives: number; eliminated: boolean }[];
  game: GameSnapshot | null;
  winner: number | null;
  entryFee: number;
  phase: TurnPhase | null;
  deadlineAt: number | null;
}

/**
 * The slice of the virtual-coin wallet the realtime layer needs.
 * `deduct` throws Error('INSUFFICIENT_COINS') when funds are missing and
 * Error('DB_REQUIRED') when the economy has no database.
 */
export interface WalletPort {
  deduct(userId: string, amount: number, reason: string, meta: unknown): Promise<number>;
  credit?(userId: string, amount: number, reason: string, meta: unknown): Promise<number>;
}

/** Room codes avoid ambiguous characters (0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function publicState(room: Room): RoomState {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map((p) => ({
      name: p.name,
      connected: p.connected,
      lives: p.lives,
      eliminated: p.eliminated,
    })),
    game: room.game ? room.game.snapshot() : null,
    winner: room.winner,
    entryFee: room.entryFee,
    phase: room.phase,
    deadlineAt: room.deadlineAt,
  };
}

export interface CreateRoomOptions {
  userId?: string;
  entryFee?: number;
}

/**
 * Result of applying a turn timeout to a room. Pure state mutation —
 * emitting the corresponding socket events is the caller's job.
 */
export interface TimeoutOutcome {
  /** False when the timeout was stale, already fired, or the game isn't live. */
  applied: boolean;
  /** Seat whose clock expired (-1 when !applied). */
  player: number;
  /** Phase that timed out ('roll' | 'move' | null). */
  phase: TurnPhase | null;
  /** Lives left on the seat after the deduction (-1 when !applied). */
  livesLeft: number;
  /** True when the seat just hit zero lives and was eliminated. */
  eliminated: boolean;
  /** Set when the elimination leaves a single seat standing: the winner. */
  winner: number | null;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  /** Rules driving the engine, lives, timers and leaderboard points. */
  readonly rules: RulesConfig;

  constructor(
    private diceFactory?: () => DiceFn,
    private wallet?: WalletPort,
    rules?: RulesConfig,
  ) {
    this.rules = rules ?? DEFAULT_RULES;
  }

  private newCode(): string {
    let code: string;
    do {
      code =
        Array.from(
          { length: CODE_LENGTH },
          () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
        ).join('');
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(playerId: string, playerName: string, opts?: CreateRoomOptions): Room {
    const entryFee = opts?.entryFee ?? 0;
    if (!Number.isInteger(entryFee) || entryFee < 0) {
      throw new Error('INVALID_ENTRY_FEE');
    }
    const code = this.newCode();
    const room: Room = {
      code,
      players: [
        {
          id: playerId,
          name: playerName.slice(0, 24) || 'Player 1',
          connected: true,
          userId: opts?.userId,
          lives: 0, // set from rules at startGame
          eliminated: false,
        },
      ],
      game: null,
      status: 'waiting',
      createdAt: Date.now(),
      moves: [],
      winner: null,
      entryFee,
      phase: null,
      deadlineAt: null,
      turnNonce: 0,
      timeoutFired: false,
    };
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  allRooms(): Room[] {
    return [...this.rooms.values()];
  }

  joinRoom(code: string, playerId: string, playerName: string, userId?: string): Room {
    const room = this.get(code);
    if (!room) throw new Error('ROOM_NOT_FOUND');
    if (room.status !== 'waiting') throw new Error('GAME_ALREADY_STARTED');
    if (room.players.length >= 4) throw new Error('ROOM_FULL');
    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      if (userId !== undefined) existing.userId = userId;
      return room; // idempotent
    }
    // Matchmaking: a seat may have been pre-created with a placeholder id but
    // the real userId. Claim it instead of adding a duplicate seat.
    if (userId) {
      const reserved = room.players.find((p) => p.userId === userId);
      if (reserved) {
        reserved.id = playerId;
        reserved.name = playerName.slice(0, 24) || reserved.name;
        reserved.connected = true;
        return room;
      }
    }
    room.players.push({
      id: playerId,
      name: playerName.slice(0, 24) || `Player ${room.players.length + 1}`,
      connected: true,
      userId,
      lives: 0, // set from rules at startGame
      eliminated: false,
    });
    return room;
  }

  async startGame(code: string, requesterId: string): Promise<Room> {
    const room = this.get(code);
    if (!room) throw new Error('ROOM_NOT_FOUND');
    if (room.status !== 'waiting') throw new Error('GAME_ALREADY_STARTED');
    if (room.players[0]?.id !== requesterId) throw new Error('ONLY_HOST_CAN_START');
    if (room.players.length < 2) throw new Error('NEED_MORE_PLAYERS');

    if (room.entryFee > 0) {
      if (!this.wallet) throw new Error('DB_REQUIRED');
      for (const p of room.players) {
        if (!p.userId) throw new Error('WALLET_REQUIRED');
      }
      // Collect the entry fee from every seat. On any failure, refund the
      // seats already charged so nobody pays for a game that never starts.
      const charged: RoomPlayer[] = [];
      try {
        for (const p of room.players) {
          await this.wallet.deduct(p.userId!, room.entryFee, 'room_entry', {
            code: room.code,
          });
          charged.push(p);
        }
      } catch (e) {
        for (const p of charged) {
          try {
            await this.wallet.credit?.(p.userId!, room.entryFee, 'room_entry_refund', {
              code: room.code,
            });
          } catch (refundError) {
            console.warn(
              `[rooms] entry-fee refund failed for ${p.userId}:`,
              (refundError as Error).message,
            );
          }
        }
        throw e;
      }
    }

    room.game = new LudoGame(room.players.length, this.diceFactory?.(), this.rules);
    for (const p of room.players) {
      p.lives = this.rules.livesPerPlayer;
      p.eliminated = false;
    }
    room.phase = null;
    room.deadlineAt = null;
    room.turnNonce = 0;
    room.timeoutFired = false;
    room.status = 'playing';
    return room;
  }

  /**
   * Apply a turn-timeout to a room: deduct exactly one life from the current
   * seat, eliminate at zero, and advance the turn past eliminated seats.
   *
   * Guards: the call is ignored when the nonce is stale (a newer turn/phase
   * already started), when it already fired for this nonce, or when the game
   * isn't live. The pending roll, if any, is forfeited with the turn — the
   * auto-pass on "no legal moves" never costs a life (that's not a timeout).
   */
  applyTimeout(room: Room, nonce: number): TimeoutOutcome {
    const g = room.game;
    const ignored = (player: number): TimeoutOutcome => ({
      applied: false,
      player,
      phase: room.phase,
      livesLeft: -1,
      eliminated: false,
      winner: null,
    });
    if (!g || room.status !== 'playing' || g.winner !== null) return ignored(-1);
    if (nonce !== room.turnNonce || room.timeoutFired) {
      return ignored(g.currentPlayer);
    }
    room.timeoutFired = true;
    const idx = g.currentPlayer;
    const seat = room.players[idx];
    // The pending roll (if any) dies with the turn.
    if (g.lastRoll !== null) {
      g.lastRoll = null;
      g.consecutiveSixes = 0;
    }
    seat.lives = Math.max(0, seat.lives - 1);
    const outcome: TimeoutOutcome = {
      applied: true,
      player: idx,
      phase: room.phase,
      livesLeft: seat.lives,
      eliminated: false,
      winner: null,
    };
    if (seat.lives === 0) {
      seat.eliminated = true;
      outcome.eliminated = true;
      const alive = room.players
        .map((p, i) => i)
        .filter((i) => !room.players[i].eliminated);
      if (alive.length <= 1) {
        outcome.winner = alive[0] ?? null;
        room.winner = outcome.winner;
        if (outcome.winner !== null) g.winner = outcome.winner;
        room.status = 'finished';
        return outcome;
      }
    }
    // Advance past eliminated seats.
    let next = (idx + 1) % g.numPlayers;
    let guard = 0;
    while (room.players[next].eliminated && guard++ < g.numPlayers) {
      next = (next + 1) % g.numPlayers;
    }
    g.currentPlayer = next;
    return outcome;
  }

  /**
   * Best-effort winner payout: the pot (entryFee × seats) goes to the
   * winner's coin account. Failures are logged and never break the game.
   */
  async awardPot(room: Room): Promise<void> {
    if (room.entryFee <= 0 || room.winner === null) return;
    const winner = room.players[room.winner];
    const credit = this.wallet?.credit;
    if (!winner?.userId || !credit) return;
    const pot = room.entryFee * room.players.length;
    try {
      await credit(winner.userId, pot, 'room_win', { code: room.code });
    } catch (e) {
      console.warn('[rooms] pot payout failed:', (e as Error).message);
    }
  }

  /**
   * Remove/mark a player. Waiting rooms drop the seat; in-game seats are kept
   * (engine player indexes are positional) and just marked disconnected.
   * Returns undefined when the room was deleted.
   */
  removePlayer(code: string, playerId: string): Room | undefined {
    const room = this.get(code);
    if (!room) return undefined;
    const idx = room.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return room;

    if (room.status === 'waiting') {
      room.players.splice(idx, 1);
      if (room.players.length === 0) {
        this.rooms.delete(room.code);
        return undefined;
      }
      return room;
    }

    room.players[idx].connected = false;
    const alive = room.players
      .map((p, i) => ({ connected: p.connected, i }))
      .filter((p) => p.connected);
    if (alive.length === 0) {
      this.rooms.delete(room.code);
      return undefined;
    }
    if (alive.length === 1 && room.status === 'playing') {
      // Last player standing wins by default.
      room.winner = alive[0].i;
      room.status = 'finished';
      if (room.game) room.game.winner = alive[0].i;
    }
    return room;
  }

  recordMove(room: Room, m: Omit<StoredMove, 'at'>): void {
    room.moves.push({ ...m, at: new Date().toISOString() });
  }

  roomCount(): number {
    return this.rooms.size;
  }
}
