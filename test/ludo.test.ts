import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE,
  HOME_END,
  LudoGame,
  chooseAiMove,
  globalSquare,
} from '../src/engine/ludo.js';

/** Deterministic dice cycling through the given values. */
const dice = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('construction', () => {
  it('rejects invalid player counts', () => {
    assert.throws(() => new LudoGame(1), /2-4/);
    assert.throws(() => new LudoGame(5), /2-4/);
  });

  it('starts with all tokens in base and player 0 to move', () => {
    const g = new LudoGame(2);
    assert.deepEqual(g.tokens, [[-1, -1, -1, -1], [-1, -1, -1, -1]]);
    assert.equal(g.currentPlayer, 0);
    assert.equal(g.winner, null);
    assert.equal(g.lastRoll, null);
  });

  it('clone() is independent of the original', () => {
    const g = new LudoGame(2, dice([6]));
    const c = g.clone();
    g.roll();
    g.move(0);
    assert.equal(c.lastRoll, null);
    assert.deepEqual(c.tokens[0], [BASE, BASE, BASE, BASE]);
  });
});

describe('dice and leaving base', () => {
  it('requires a 6 to leave base; otherwise the turn passes', () => {
    const g = new LudoGame(2, dice([3]));
    assert.equal(g.roll(), 3);
    assert.deepEqual(g.movableTokens(), []);
    g.passTurn();
    assert.equal(g.currentPlayer, 1);
  });

  it('a 6 brings a token out with an extra turn', () => {
    const g = new LudoGame(2, dice([6]));
    assert.equal(g.roll(), 6);
    assert.deepEqual(g.movableTokens(), [0, 1, 2, 3]);
    const o = g.move(0);
    assert.equal(o.from, BASE);
    assert.equal(o.to, 0);
    assert.equal(g.tokens[0][0], 0);
    assert.equal(o.extraTurn, true);
    assert.equal(g.currentPlayer, 0); // same player rolls again
  });

  it('cannot roll twice without moving', () => {
    const g = new LudoGame(2, dice([6, 6]));
    g.roll();
    assert.throws(() => g.roll(), /move the dice/);
  });

  it('cannot move before rolling', () => {
    const g = new LudoGame(2, dice([6]));
    assert.throws(() => g.move(0), /roll the dice/);
  });

  it('rejects an out-of-range token index', () => {
    const g = new LudoGame(2, dice([6]));
    g.roll();
    assert.throws(() => g.move(9), /invalid token/);
    assert.throws(() => g.move(-1), /invalid token/);
  });

  it('rejects moving a token that has no legal move', () => {
    const g = new LudoGame(2, dice([6]));
    g.tokens[0][0] = 55; // 55 + 6 = 61 > 56: overshoot, illegal
    g.roll();
    assert.deepEqual(g.movableTokens(), [1, 2, 3]);
    assert.throws(() => g.move(0), /cannot move/);
  });
});

describe('movement', () => {
  it('moves a token forward by the roll', () => {
    const g = new LudoGame(2, dice([6, 4]));
    g.roll(); g.move(0); // out to 0, extra turn
    assert.equal(g.roll(), 4);
    const o = g.move(0);
    assert.deepEqual([o.from, o.to], [0, 4]);
    assert.equal(g.tokens[0][0], 4);
    assert.equal(g.currentPlayer, 1); // no extra turn on a plain 4
  });

  it('globalSquare maps relative positions correctly', () => {
    assert.equal(globalSquare(0, 0), 0);
    assert.equal(globalSquare(1, 0), 13);
    assert.equal(globalSquare(2, 0), 26);
    assert.equal(globalSquare(3, 0), 39);
    assert.equal(globalSquare(0, 51), null); // home column: off the main track
    assert.equal(globalSquare(1, 43), 4); // (13 + 43) % 52
  });
});

describe('captures', () => {
  it('captures an opponent token on an unsafe square and grants an extra turn', () => {
    const g = new LudoGame(2, dice([1]));
    g.tokens[0][0] = 3; // P0 global 3
    g.tokens[1][0] = 43; // P1 global (13+43)%52 = 4 -> unsafe
    g.roll();
    const o = g.move(0);
    assert.equal(o.to, 4);
    assert.equal(o.captured.length, 1);
    assert.deepEqual(o.captured[0], { player: 1, tokenIndex: 0 });
    assert.equal(g.tokens[1][0], BASE);
    assert.equal(o.extraTurn, true);
    assert.equal(g.currentPlayer, 0);
  });

  it('does not capture on safe squares', () => {
    const g = new LudoGame(2, dice([1]));
    g.tokens[0][0] = 7; // global 7
    g.tokens[1][0] = 47; // P1 global (13+47)%52 = 8 -> safe star
    g.roll();
    const o = g.move(0);
    assert.equal(o.to, 8);
    assert.equal(o.captured.length, 0);
    assert.equal(g.tokens[1][0], 47);
    assert.equal(o.extraTurn, false);
    assert.equal(g.currentPlayer, 1);
  });

  it('leaving base onto the (safe) start square never captures', () => {
    const g = new LudoGame(2, dice([6]));
    g.tokens[1][0] = 39; // P1 global (13+39)%52 = 0 -> P0 start, safe
    g.roll();
    const o = g.move(0);
    assert.equal(o.to, 0);
    assert.equal(o.captured.length, 0);
    assert.equal(g.tokens[1][0], 39);
  });
});

describe('home stretch and winning', () => {
  it('needs an exact roll to reach home; overshoot is illegal', () => {
    const g = new LudoGame(2, dice([2]));
    g.tokens[0][0] = 54;
    g.tokens[0][1] = 55; // 55 + 2 = 57 > 56 -> cannot move
    g.roll();
    assert.deepEqual(g.movableTokens(), [0]);
    const o = g.move(0);
    assert.equal(o.to, HOME_END);
    assert.equal(o.reachedHome, true);
    assert.equal(o.extraTurn, true); // reaching home grants an extra turn
  });

  it('finished tokens are never movable', () => {
    const g = new LudoGame(2, dice([6]));
    g.tokens[0][0] = HOME_END;
    g.roll();
    assert.deepEqual(g.movableTokens(), [1, 2, 3]);
  });

  it('wins when all four tokens reach home', () => {
    const g = new LudoGame(2, dice([1]));
    g.tokens[0] = [HOME_END, HOME_END, HOME_END, 55];
    g.roll();
    const o = g.move(3);
    assert.equal(o.winner, 0);
    assert.equal(g.winner, 0);
    assert.equal(o.extraTurn, false);
    assert.throws(() => g.roll(), /game is over/);
    assert.throws(() => g.move(0), /game is over/);
  });
});

describe('three consecutive sixes', () => {
  it('forfeits the turn on the third six', () => {
    const g = new LudoGame(2, dice([6, 6, 6]));
    g.tokens[0][0] = 10;
    g.roll(); g.move(0);
    assert.equal(g.currentPlayer, 0);
    g.roll(); g.move(0);
    assert.equal(g.currentPlayer, 0);
    assert.equal(g.roll(), 6);
    assert.deepEqual(g.movableTokens(), []); // no moves allowed
    g.passTurn();
    assert.equal(g.currentPlayer, 1);
    assert.equal(g.consecutiveSixes, 0);
  });
});

describe('AI', () => {
  it('prefers a capturing move', () => {
    const g = new LudoGame(2, dice([1]));
    g.tokens[0][0] = 3; // can capture P1 on global 4
    g.tokens[0][1] = 20; // plain move
    g.tokens[1][0] = 43; // global 4, unsafe
    g.roll();
    assert.equal(chooseAiMove(g), 0);
  });

  it('brings a token out of base on a 6', () => {
    const g = new LudoGame(2, dice([6]));
    g.roll();
    const pick = chooseAiMove(g);
    assert.ok(pick !== null && pick >= 0 && pick < 4);
    g.move(pick!);
    assert.equal(g.tokens[0][pick!], 0);
  });

  it('returns null when no move exists', () => {
    const g = new LudoGame(2, dice([2]));
    g.roll();
    assert.equal(chooseAiMove(g), null);
  });

  it('two AIs can play a full game to completion', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return 1 + (seed % 6);
    };
    const g = new LudoGame(2, rand);
    let halfTurns = 0;
    while (g.winner === null && halfTurns < 20000) {
      halfTurns++;
      g.roll();
      const mv = chooseAiMove(g);
      if (mv === null) g.passTurn();
      else g.move(mv);
    }
    assert.notEqual(g.winner, null, 'AI vs AI game should finish');
    assert.ok(halfTurns < 20000, 'game finished in a sane number of turns');
    const champ = g.winner as number;
    assert.deepEqual(g.tokens[champ], [HOME_END, HOME_END, HOME_END, HOME_END]);
  });
});

describe('snapshots', () => {
  it('snapshot() reflects the board for clients', () => {
    const g = new LudoGame(3, dice([6]));
    g.roll(); g.move(2);
    const s = g.snapshot();
    assert.equal(s.numPlayers, 3);
    assert.equal(s.tokens[0][2], 0);
    assert.equal(s.currentPlayer, 0);
  });
});
