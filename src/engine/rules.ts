/**
 * Configurable Ludo rules — the premium redesign's rule set.
 *
 * The engine (ludo.ts) reads everything behavioral from here instead of
 * hard-coded constants, so game variants only need a different config.
 * Timers/lives/points live here too so rooms, sockets, the leaderboard and
 * the rewards endpoints all share one source of truth.
 */
export interface RulesConfig {
  /** Seconds the current player has to roll the dice. */
  diceTimeoutSec: number;
  /** Seconds the current player has to move after a roll. */
  moveTimeoutSec: number;
  /** Lives each player starts with; a missed timer costs exactly one. */
  livesPerPlayer: number;
  /** True = a token needs a 6 to leave the base. */
  sixToUnlock: boolean;
  /** Rolling a 6 grants an extra turn. */
  extraTurnOnSix: boolean;
  /** Capturing an opponent token grants an extra turn. */
  extraTurnOnCapture: boolean;
  /** Bringing a token home grants an extra turn. */
  extraTurnOnHome: boolean;
  /**
   * Cap on bonus turns granted by a single move action. The engine's
   * `extraTurn` is a boolean, so one action can never grant more than one
   * bonus turn — chaining requires re-earning it on the next roll.
   */
  maxBonusTurnsPerAction: number;
  /** Consecutive sixes at/above this forfeit the turn (no move). */
  maxConsecutiveSixes: number;
  /** True = a token must land exactly on the home square to finish. */
  exactRollHome: boolean;
  /** Coins credited to the winner's wallet on a victory claim. */
  victoryBonusCoins: number;
  /** Leaderboard points for winning a match. */
  winPoints: number;
  /** Leaderboard points for losing a match (participation). */
  lossPoints: number;
}

export const DEFAULT_RULES: RulesConfig = {
  diceTimeoutSec: 15,
  moveTimeoutSec: 15,
  livesPerPlayer: 5,
  sixToUnlock: true,
  extraTurnOnSix: true,
  extraTurnOnCapture: true,
  extraTurnOnHome: true,
  maxBonusTurnsPerAction: 1,
  maxConsecutiveSixes: 3,
  exactRollHome: true,
  victoryBonusCoins: 25,
  winPoints: 100,
  lossPoints: 10,
};
