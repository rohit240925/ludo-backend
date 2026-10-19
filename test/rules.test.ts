import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LudoGame } from '../src/engine/ludo.js';
import { DEFAULT_RULES, RulesConfig } from '../src/engine/rules.js';

function seqDice(seq: number[]): () => number {
  let i = 0;
  return () => seq[i++ % seq.length];
}

function withRules(partial: Partial<RulesConfig>): RulesConfig {
  return { ...DEFAULT_RULES, ...partial };
}

describe('rules config (engine)', () => {
  it('defaults to DEFAULT_RULES and clone() preserves custom rules', () => {
    const g = new LudoGame(2);
    assert.deepEqual(g.rules, DEFAULT_RULES);
    assert.equal(g.rules.maxConsecutiveSixes, 3);

    const custom = withRules({ maxConsecutiveSixes: 2, sixToUnlock: false });
    const c = new LudoGame(2, undefined, custom);
    assert.equal(c.rules.maxConsecutiveSixes, 2);
    assert.equal(c.rules.sixToUnlock, false);
    const clone = c.clone();
    assert.equal(clone.rules.maxConsecutiveSixes, 2);
    assert.equal(clone.rules.sixToUnlock, false);
  });

  it('extraTurn is boolean-capped: one bonus turn per move action, never stacked', () => {
    const g = new LudoGame(2, seqDice([6, 3]));
    // Roll 6, bring a token out: exactly one bonus turn is granted.
    assert.equal(g.roll(), 6);
    const first = g.move(0);
    assert.equal(first.extraTurn, true);
    assert.equal(typeof first.extraTurn, 'boolean');
    assert.equal(g.currentPlayer, 0); // bonus turn consumed: same player rolls again

    // The bonus roll earns nothing (3, no capture, no home): the turn passes.
    assert.equal(g.roll(), 3);
    const second = g.move(0);
    assert.equal(second.extraTurn, false);
    assert.equal(g.currentPlayer, 1);
  });

  it('stacked bonus conditions on one move still grant exactly one extra turn', () => {
    // Token 0 at rel 10; opponent token where a 6 lands (rel 16, unsafe).
    // globalSquare(1, 3) = (13 + 3) % 52 = 16.
    const g = new LudoGame(2, seqDice([6, 4]));
    g.tokens[0][0] = 10;
    g.tokens[1][0] = 3;
    assert.equal(g.roll(), 6);
    const outcome = g.move(0);
    assert.equal(outcome.roll, 6);
    assert.deepEqual(outcome.captured, [{ player: 1, tokenIndex: 0 }]);
    assert.equal(outcome.extraTurn, true); // boolean: one bonus turn, not two
    assert.equal(g.currentPlayer, 0);

    // Bonus turn earns nothing -> the turn passes (no stacking).
    assert.equal(g.roll(), 4);
    const next = g.move(0);
    assert.equal(next.extraTurn, false);
    assert.equal(g.currentPlayer, 1);
  });

  it('extraTurnOnSix=false: a 6 grants no bonus turn', () => {
    const g = new LudoGame(2, seqDice([6]), withRules({ extraTurnOnSix: false }));
    assert.equal(g.roll(), 6);
    const outcome = g.move(0);
    assert.equal(outcome.extraTurn, false);
    assert.equal(g.currentPlayer, 1);
  });

  it('extraTurnOnCapture: a capture without a 6 grants a bonus turn', () => {
    // Player 0 token at rel 10, roll 4 -> rel 14 (global 14, unsafe).
    // globalSquare(1, 1) = 14 -> opponent token there is captured.
    const g = new LudoGame(2, seqDice([4]), withRules({}));
    g.tokens[0][0] = 10;
    g.tokens[1][0] = 1;
    assert.equal(g.roll(), 4);
    const outcome = g.move(0);
    assert.deepEqual(outcome.captured, [{ player: 1, tokenIndex: 0 }]);
    assert.equal(outcome.extraTurn, true);
    assert.equal(g.currentPlayer, 0);
  });

  it('extraTurnOnCapture=false: a capture grants no bonus turn', () => {
    const g = new LudoGame(2, seqDice([4]), withRules({ extraTurnOnCapture: false }));
    g.tokens[0][0] = 10;
    g.tokens[1][0] = 1;
    assert.equal(g.roll(), 4);
    const outcome = g.move(0);
    assert.deepEqual(outcome.captured, [{ player: 1, tokenIndex: 0 }]);
    assert.equal(outcome.extraTurn, false);
    assert.equal(g.currentPlayer, 1);
  });

  it('maxConsecutiveSixes is threaded from rules (custom value 2)', () => {
    const g = new LudoGame(2, seqDice([6]), withRules({ maxConsecutiveSixes: 2 }));
    assert.equal(g.roll(), 6);
    const first = g.move(0);
    assert.equal(first.extraTurn, true);
    assert.equal(g.consecutiveSixes, 1);
    // Second six hits the custom cap: no legal moves, the move forfeits.
    assert.equal(g.roll(), 6);
    assert.equal(g.consecutiveSixes, 2);
    assert.deepEqual(g.movableTokens(), []);
    const forfeited = g.move(0);
    assert.equal(forfeited.forfeited, true);
    assert.equal(g.currentPlayer, 1);
  });

  it('sixToUnlock=false: any roll can bring a token out of base', () => {
    const g = new LudoGame(2, seqDice([3]), withRules({ sixToUnlock: false }));
    assert.equal(g.roll(), 3);
    assert.deepEqual(g.movableTokens(), [0, 1, 2, 3]);
    const outcome = g.move(2);
    assert.equal(outcome.from, -1);
    assert.equal(outcome.to, 0);
  });

  it('sixToUnlock=true (default): only a 6 unlocks', () => {
    const g = new LudoGame(2, seqDice([3]));
    assert.equal(g.roll(), 3);
    assert.deepEqual(g.movableTokens(), []);
  });

  it('exactRollHome=false: an overshooting roll still brings the token home', () => {
    const g = new LudoGame(2, seqDice([4]), withRules({ exactRollHome: false }));
    g.tokens[0][0] = 54;
    assert.equal(g.roll(), 4);
    assert.deepEqual(g.movableTokens(), [0]);
    const outcome = g.move(0);
    assert.equal(outcome.to, 56);
    assert.equal(outcome.reachedHome, true);
  });

  it('exactRollHome=true (default): overshoot is not a legal move', () => {
    const g = new LudoGame(2, seqDice([4]));
    g.tokens[0][0] = 54;
    g.tokens[0][1] = 10;
    assert.equal(g.roll(), 4);
    assert.deepEqual(g.movableTokens(), [1]); // token 0 (54+4) excluded
  });
});
