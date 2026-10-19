import { DEFAULT_RULES, RulesConfig } from './rules.js';

/**
 * Ludo rules engine — pure game logic, zero I/O.
 *
 * Design notes (also see docs/ARCHITECTURE.md):
 * - Positions are RELATIVE to each player: this keeps the engine small and
 *   makes a future Kotlin port straightforward (same constants, same flow).
 * - Token position encoding:
 *     -1            -> in the base (yard)
 *      0..50        -> on the main 52-cell track (0 = player's start square)
 *     51..55        -> home column
 *     56 (HOME_END) -> finished (home triangle)
 * - The dice function is injectable so tests (and replays) are deterministic.
 * - Extra turn: rolling a 6, capturing an opponent, or bringing a token home
 *   (each toggleable via RulesConfig).
 * - maxConsecutiveSixes consecutive sixes: turn is forfeited (no move).
 */

export const NUM_TOKENS = 4;
export const TRACK_SIZE = 52;
/** Global index of each player's start square on the main track. */
export const START_OFFSETS = [0, 13, 26, 39] as const;
/** Global squares where captures are not allowed (starts + star squares). */
export const SAFE_SQUARES: ReadonlySet<number> = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
export const BASE = -1;
export const TRACK_END = 50;
export const HOME_END = 56;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export interface Capture {
  player: number;
  tokenIndex: number;
}

export interface MoveOutcome {
  player: number;
  tokenIndex: number;
  roll: number;
  from: number;
  to: number;
  captured: Capture[];
  reachedHome: boolean;
  extraTurn: boolean;
  /** True when the move was skipped because of three consecutive sixes. */
  forfeited: boolean;
  winner: number | null;
}

export interface GameSnapshot {
  numPlayers: number;
  currentPlayer: number;
  lastRoll: number | null;
  consecutiveSixes: number;
  winner: number | null;
  tokens: number[][];
}

export type DiceFn = () => number;

/** Global track index for a player's relative position, or null when off the main track. */
export function globalSquare(player: number, relPos: number): number | null {
  if (relPos < 0 || relPos > TRACK_END) return null;
  return (START_OFFSETS[player] + relPos) % TRACK_SIZE;
}

export class LudoGame {
  readonly numPlayers: number;
  readonly rules: RulesConfig;
  tokens: number[][];
  currentPlayer = 0;
  lastRoll: number | null = null;
  consecutiveSixes = 0;
  winner: number | null = null;
  private dice: DiceFn;

  constructor(numPlayers: number, dice?: DiceFn, rules?: RulesConfig) {
    if (!Number.isInteger(numPlayers) || numPlayers < MIN_PLAYERS || numPlayers > MAX_PLAYERS) {
      throw new Error(`numPlayers must be ${MIN_PLAYERS}-${MAX_PLAYERS}`);
    }
    this.numPlayers = numPlayers;
    this.rules = rules ?? DEFAULT_RULES;
    this.tokens = Array.from({ length: numPlayers }, () => Array(NUM_TOKENS).fill(BASE));
    this.dice = dice ?? (() => 1 + Math.floor(Math.random() * 6));
  }

  clone(): LudoGame {
    const g = new LudoGame(this.numPlayers, this.dice, this.rules);
    g.tokens = this.tokens.map((row) => [...row]);
    g.currentPlayer = this.currentPlayer;
    g.lastRoll = this.lastRoll;
    g.consecutiveSixes = this.consecutiveSixes;
    g.winner = this.winner;
    return g;
  }

  roll(): number {
    if (this.winner !== null) throw new Error('cannot roll: game is over');
    if (this.lastRoll !== null) throw new Error('cannot roll: move the dice result first');
    const value = this.dice();
    if (!Number.isInteger(value) || value < 1 || value > 6) {
      throw new Error('dice function must return an integer 1-6');
    }
    this.consecutiveSixes = value === 6 ? this.consecutiveSixes + 1 : 0;
    this.lastRoll = value;
    return value;
  }

  /** Token indices the current player may legally move for the pending roll. */
  movableTokens(): number[] {
    if (this.lastRoll === null || this.winner !== null) return [];
    // Too many consecutive sixes: the turn is forfeited.
    if (this.consecutiveSixes >= this.rules.maxConsecutiveSixes) return [];
    const roll = this.lastRoll;
    const p = this.currentPlayer;
    const out: number[] = [];
    for (let t = 0; t < NUM_TOKENS; t++) {
      const pos = this.tokens[p][t];
      if (pos === HOME_END) continue;
      if (pos === BASE) {
        if (roll === 6 || !this.rules.sixToUnlock) out.push(t);
      } else if (pos + roll <= HOME_END || !this.rules.exactRollHome) {
        out.push(t);
      }
    }
    return out;
  }

  move(tokenIndex: number): MoveOutcome {
    const p = this.currentPlayer;
    if (this.winner !== null) throw new Error('cannot move: game is over');
    if (this.lastRoll === null) throw new Error('cannot move: roll the dice first');
    if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex >= NUM_TOKENS) {
      throw new Error(`invalid token index ${tokenIndex}`);
    }
    const roll = this.lastRoll;

    // maxConsecutiveSixes reached -> the turn is forfeited, the board is untouched.
    if (this.consecutiveSixes >= this.rules.maxConsecutiveSixes) {
      const pos = this.tokens[p][tokenIndex];
      this.lastRoll = null;
      this.consecutiveSixes = 0;
      this.currentPlayer = (p + 1) % this.numPlayers;
      return {
        player: p, tokenIndex, roll, from: pos, to: pos,
        captured: [], reachedHome: false, extraTurn: false, forfeited: true, winner: null,
      };
    }

    if (!this.movableTokens().includes(tokenIndex)) {
      throw new Error(`token ${tokenIndex} cannot move with roll ${roll}`);
    }

    const from = this.tokens[p][tokenIndex];
    // Without exactRollHome an overshooting roll still brings the token home.
    const to = from === BASE ? 0 : this.rules.exactRollHome ? from + roll : Math.min(from + roll, HOME_END);
    this.tokens[p][tokenIndex] = to;

    // Captures: every opponent token on the landing square goes back to base,
    // unless the square is safe.
    const captured: Capture[] = [];
    const landing = globalSquare(p, to);
    if (landing !== null && !SAFE_SQUARES.has(landing)) {
      for (let q = 0; q < this.numPlayers; q++) {
        if (q === p) continue;
        for (let t = 0; t < NUM_TOKENS; t++) {
          const qp = this.tokens[q][t];
          if (qp >= 0 && qp <= TRACK_END && globalSquare(q, qp) === landing) {
            this.tokens[q][t] = BASE;
            captured.push({ player: q, tokenIndex: t });
          }
        }
      }
    }

    const reachedHome = to === HOME_END;
    const winner = this.tokens[p].every((x) => x === HOME_END) ? p : null;
    this.winner = winner;

    // extraTurn is a boolean: one move action can grant at most ONE bonus
    // turn (maxBonusTurnsPerAction = 1). Chaining needs re-earning it on the
    // next roll, so bonus turns can never stack up from a single action.
    const r = this.rules;
    const extraTurn =
      winner === null &&
      ((roll === 6 && r.extraTurnOnSix) ||
        (captured.length > 0 && r.extraTurnOnCapture) ||
        (reachedHome && r.extraTurnOnHome));
    this.lastRoll = null;
    if (!extraTurn) {
      this.consecutiveSixes = 0;
      this.currentPlayer = (p + 1) % this.numPlayers;
    }
    return { player: p, tokenIndex, roll, from, to, captured, reachedHome, extraTurn, forfeited: false, winner };
  }

  /** Pass the turn when the pending roll has no legal moves. */
  passTurn(): void {
    if (this.lastRoll === null) throw new Error('cannot pass: no pending roll');
    if (this.movableTokens().length > 0) throw new Error('cannot pass: there are legal moves');
    this.lastRoll = null;
    this.consecutiveSixes = 0;
    this.currentPlayer = (this.currentPlayer + 1) % this.numPlayers;
  }

  snapshot(): GameSnapshot {
    return {
      numPlayers: this.numPlayers,
      currentPlayer: this.currentPlayer,
      lastRoll: this.lastRoll,
      consecutiveSixes: this.consecutiveSixes,
      winner: this.winner,
      tokens: this.tokens.map((row) => [...row]),
    };
  }
}

// ---------------------------------------------------------------------------
// Simple AI opponent (heuristic, deterministic). Lives in the engine so the
// same logic can be ported to Kotlin for offline play inside the Android lib.
// ---------------------------------------------------------------------------

function scoreMove(game: LudoGame, player: number, tokenIndex: number): number {
  const sim = game.clone();
  const outcome = sim.move(tokenIndex);
  let score = 0;
  if (outcome.captured.length > 0) score += 100 + 25 * outcome.captured.length;
  if (outcome.reachedHome) score += 60;
  if (outcome.from === BASE) score += 40; // got a token out
  const landing = globalSquare(player, outcome.to);
  if (landing !== null) {
    if (SAFE_SQUARES.has(landing)) score += 15;
    else score -= 6; // exposed on an unsafe square
  }
  score += outcome.to * 0.4; // prefer advanced tokens
  return score;
}

/** Pick the best token to move for the current player, or null when no move exists. */
export function chooseAiMove(game: LudoGame): number | null {
  const moves = game.movableTokens();
  if (moves.length === 0) return null;
  const player = game.currentPlayer;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const t of moves) {
    const s = scoreMove(game, player, t);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return best;
}
