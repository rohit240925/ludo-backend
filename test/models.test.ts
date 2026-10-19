import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameRecord } from '../src/models/GameRecord.js';

/**
 * Schema validation tests. These run WITHOUT a MongoDB connection —
 * mongoose validate() is pure and local, which is exactly what we want
 * since persistence is optional in this project.
 */
describe('GameRecord model', () => {
  it('validates a complete match record without a DB connection', async () => {
    const doc = new GameRecord({
      code: 'ABC123',
      numPlayers: 2,
      playerNames: ['Asha', 'Bala'],
      winner: 0,
      moves: [
        { player: 0, tokenIndex: 0, roll: 6, from: -1, to: 0, captured: 0, at: new Date() },
        { player: 0, tokenIndex: 0, roll: 4, from: 0, to: 4, captured: 0, at: new Date() },
      ],
      startedAt: new Date(),
      endedAt: new Date(),
    });
    await doc.validate(); // throws on any validation error
  });

  it('requires a room code', async () => {
    const doc = new GameRecord({ numPlayers: 2, playerNames: ['A'] });
    await assert.rejects(() => doc.validate(), /code/);
  });

  it('defaults an empty move list', async () => {
    const doc = new GameRecord({ code: 'XYZ789', numPlayers: 4, playerNames: ['a', 'b', 'c', 'd'] });
    await doc.validate();
    assert.deepEqual(doc.moves, []);
    assert.equal(doc.winner, null);
  });
});
