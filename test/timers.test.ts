import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server as HttpServer } from 'node:http';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { buildServer } from '../src/server.js';
import { RoomManager } from '../src/realtime/rooms.js';
import { DEFAULT_RULES, RulesConfig } from '../src/engine/rules.js';

function waitFor<T>(socket: ClientSocket, event: string, timeoutMs = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for '${event}'`)),
      timeoutMs,
    );
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function fastRules(partial: Partial<RulesConfig>): RulesConfig {
  return { ...DEFAULT_RULES, diceTimeoutSec: 0.5, moveTimeoutSec: 0.5, ...partial };
}

describe('turn timers + lives (socket.io)', () => {
  let httpServer: HttpServer;
  let url: string;

  before(async () => {
    // Deterministic dice (always 6) + short timers + 3 lives per player.
    const built = buildServer({
      diceFactory: () => () => 6,
      rules: fastRules({ livesPerPlayer: 3 }),
    });
    httpServer = built.httpServer;
    await new Promise<void>((r) => httpServer.listen(0, r));
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((e) => (e ? reject(e) : resolve())),
    );
  });

  /** Create a started game; resolves with the opening timer_started payload. */
  async function newGame(names: string[]) {
    const sockets = names.map(() => ioClient(url));
    const [a] = sockets;
    await Promise.all(sockets.map((s) => waitFor(s, 'connect')));
    a.emit('create_room', { playerName: names[0] });
    const created: any = await waitFor(a, 'room_created');
    for (let i = 1; i < sockets.length; i++) {
      sockets[i].emit('join_room', { code: created.code, playerName: names[i] });
      await waitFor(sockets[i], 'room_joined');
    }
    const startedP = waitFor(a, 'game_started');
    const timerP = waitFor<any>(a, 'timer_started');
    a.emit('start_game', { code: created.code });
    await startedP;
    const t0 = await timerP;
    return { sockets, a, code: created.code, t0 };
  }

  function closeAll(sockets: ClientSocket[]): void {
    for (const s of sockets) s.close();
  }

  it('opening timer_started carries the server clock (phase, deadlineAt, player, lives)', async () => {
    const { sockets, t0 } = await newGame(['A', 'B']);
    try {
      assert.equal(t0.phase, 'roll');
      assert.equal(t0.player, 0);
      assert.ok(typeof t0.deadlineAt === 'number' && t0.deadlineAt > Date.now());
      assert.equal(t0.state.players[0].lives, 3);
      assert.equal(t0.state.players[0].eliminated, false);
      assert.equal(t0.state.phase, 'roll');
      assert.equal(t0.state.deadlineAt, t0.deadlineAt);
    } finally {
      closeAll(sockets);
    }
  });

  it('roll-phase timeout deducts exactly one life and passes the turn', async () => {
    const { sockets, a } = await newGame(['A', 'B']);
    try {
      const livesP = waitFor<any>(a, 'lives_changed');
      const timeoutP = waitFor<any>(a, 'turn_timeout');
      const changedP = waitFor<any>(a, 'turn_changed');
      const nextTimerP = waitFor<any>(a, 'timer_started');

      const lives: any = await livesP;
      assert.equal(lives.player, 0);
      assert.equal(lives.lives, 2);
      assert.equal(lives.state.players[0].lives, 2);

      const timeout: any = await timeoutP;
      assert.equal(timeout.player, 0);
      assert.equal(timeout.phase, 'roll');
      assert.equal(timeout.livesLeft, 2);

      const changed: any = await changedP;
      assert.equal(changed.currentPlayer, 1);
      assert.equal(changed.reason, 'timeout');

      const next: any = await nextTimerP;
      assert.equal(next.phase, 'roll');
      assert.equal(next.player, 1);
      assert.ok(next.deadlineAt > Date.now());
    } finally {
      closeAll(sockets);
    }
  });

  it('move-phase timeout clears the pending roll and costs one life', async () => {
    const { sockets, a, code } = await newGame(['A', 'B']);
    try {
      const moveTimerP = waitFor<any>(a, 'timer_started');
      a.emit('roll_dice', { code });
      const rolled: any = await waitFor(a, 'dice_rolled');
      assert.equal(rolled.value, 6);
      assert.deepEqual(rolled.moves, [0, 1, 2, 3]);

      const moveTimer: any = await moveTimerP;
      assert.equal(moveTimer.phase, 'move');
      assert.equal(moveTimer.player, 0);

      const timeoutP = waitFor<any>(a, 'turn_timeout');
      const nextTimerP = waitFor<any>(a, 'timer_started');
      const timeout: any = await timeoutP;
      assert.equal(timeout.player, 0);
      assert.equal(timeout.phase, 'move');
      assert.equal(timeout.livesLeft, 2);

      const next: any = await nextTimerP;
      assert.equal(next.player, 1);
      assert.equal(next.phase, 'roll');
      // The pending roll died with the timed-out turn.
      assert.equal(next.state.game.lastRoll, null);
      assert.equal(next.state.players[0].lives, 2);
    } finally {
      closeAll(sockets);
    }
  });

  it('applyTimeout is exactly-once per nonce: a double invoke cannot double-deduct', async () => {
    const mgr = new RoomManager(undefined, undefined, fastRules({ livesPerPlayer: 3 }));
    const room = mgr.createRoom('s1', 'A');
    mgr.joinRoom(room.code, 's2', 'B');
    await mgr.startGame(room.code, 's1');
    room.turnNonce = 41;
    room.phase = 'roll';
    room.deadlineAt = Date.now() - 1000;
    room.timeoutFired = false;

    const first = mgr.applyTimeout(room, 41);
    assert.equal(first.applied, true);
    assert.equal(first.player, 0);
    assert.equal(first.livesLeft, 2);
    assert.equal(room.players[0].lives, 2);

    // Second invoke with the same nonce: ignored, no second deduction.
    const second = mgr.applyTimeout(room, 41);
    assert.equal(second.applied, false);
    assert.equal(room.players[0].lives, 2);

    // A stale nonce after the turn advanced is ignored too.
    room.turnNonce = 42;
    room.timeoutFired = false;
    const stale = mgr.applyTimeout(room, 41);
    assert.equal(stale.applied, false);
    assert.equal(room.players[0].lives, 2);
  });

  it('elimination at zero lives ends a 2-player game: opponent wins', async () => {
    const built = buildServer({
      diceFactory: () => () => 6,
      rules: fastRules({ livesPerPlayer: 1 }),
    });
    const srv: HttpServer = built.httpServer;
    await new Promise<void>((r) => srv.listen(0, r));
    const { port } = srv.address() as AddressInfo;
    const u = `http://127.0.0.1:${port}`;
    const a = ioClient(u);
    const b = ioClient(u);
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
      a.emit('create_room', { playerName: 'A' });
      const created: any = await waitFor(a, 'room_created');
      b.emit('join_room', { code: created.code, playerName: 'B' });
      await waitFor(b, 'room_joined');

      const elimP = waitFor<any>(a, 'player_eliminated');
      const overP = waitFor<any>(a, 'game_over');
      const startedP = waitFor(a, 'game_started');
      a.emit('start_game', { code: created.code });
      await startedP;

      const elim: any = await elimP;
      assert.equal(elim.player, 0);
      assert.equal(elim.state.players[0].eliminated, true);
      assert.equal(elim.state.players[0].lives, 0);

      const over: any = await overP;
      assert.equal(over.reason, 'elimination');
      assert.equal(over.winner, 1);
      assert.equal(over.state.status, 'finished');
    } finally {
      a.close();
      b.close();
      await new Promise<void>((resolve, reject) =>
        srv.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('elimination in a 3-player game continues with the next live seat', async () => {
    const built = buildServer({
      diceFactory: () => () => 6,
      rules: fastRules({ livesPerPlayer: 1, diceTimeoutSec: 1, moveTimeoutSec: 1 }),
    });
    const srv: HttpServer = built.httpServer;
    await new Promise<void>((r) => srv.listen(0, r));
    const { port } = srv.address() as AddressInfo;
    const u = `http://127.0.0.1:${port}`;
    const a = ioClient(u);
    const b = ioClient(u);
    const c = ioClient(u);
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect'), waitFor(c, 'connect')]);
      a.emit('create_room', { playerName: 'A' });
      const created: any = await waitFor(a, 'room_created');
      b.emit('join_room', { code: created.code, playerName: 'B' });
      await waitFor(b, 'room_joined');
      c.emit('join_room', { code: created.code, playerName: 'C' });
      await waitFor(c, 'room_joined');

      const elimP = waitFor<any>(b, 'player_eliminated');
      const openTimerP = waitFor<any>(b, 'timer_started');
      const startedP = waitFor(a, 'game_started');
      a.emit('start_game', { code: created.code });
      await startedP;
      await openTimerP; // opening roll clock for player 0

      const nextTimerP = waitFor<any>(b, 'timer_started');
      const elim: any = await elimP;
      assert.equal(elim.player, 0);

      const next: any = await nextTimerP;
      assert.equal(next.player, 1); // turn advanced past the eliminated seat
      assert.equal(next.phase, 'roll');
      assert.equal(next.state.status, 'playing');
      assert.equal(next.state.players[0].eliminated, true);

      // The game continues: player 1 can roll.
      const rolledP = waitFor<any>(b, 'dice_rolled');
      b.emit('roll_dice', { code: created.code });
      const rolled: any = await rolledP;
      assert.equal(rolled.player, 1);
      assert.equal(rolled.value, 6);
    } finally {
      a.close();
      b.close();
      c.close();
      await new Promise<void>((resolve, reject) =>
        srv.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('auto-pass on no legal moves costs no life', async () => {
    // Dice never rolls 6, so tokens stuck in base can never move; timeouts
    // are long so no timer can interfere with the assertion.
    const built = buildServer({
      diceFactory: () => () => 3,
      rules: { ...DEFAULT_RULES, diceTimeoutSec: 30, moveTimeoutSec: 30 },
    });
    const srv: HttpServer = built.httpServer;
    await new Promise<void>((r) => srv.listen(0, r));
    const { port } = srv.address() as AddressInfo;
    const u = `http://127.0.0.1:${port}`;
    const a = ioClient(u);
    const b = ioClient(u);
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
      a.emit('create_room', { playerName: 'A' });
      const created: any = await waitFor(a, 'room_created');
      b.emit('join_room', { code: created.code, playerName: 'B' });
      await waitFor(b, 'room_joined');

      let livesLost = 0;
      let timedOut = 0;
      a.on('lives_changed', () => livesLost++);
      a.on('turn_timeout', () => timedOut++);

      const rolledP = waitFor<any>(a, 'dice_rolled');
      const changedP = waitFor<any>(a, 'turn_changed');
      const openTimerP = waitFor<any>(a, 'timer_started');
      const startedP = waitFor(a, 'game_started');
      a.emit('start_game', { code: created.code });
      await startedP;
      await openTimerP; // opening roll clock for player 0

      const nextTimerP = waitFor<any>(a, 'timer_started');
      a.emit('roll_dice', { code: created.code });
      const rolled: any = await rolledP;
      assert.equal(rolled.value, 3);
      assert.deepEqual(rolled.moves, []);

      const changed: any = await changedP;
      assert.equal(changed.reason, 'no_moves');
      assert.equal(changed.currentPlayer, 1);

      const next: any = await nextTimerP;
      assert.equal(next.player, 1);
      assert.equal(next.state.players[0].lives, 5); // untouched
      assert.equal(livesLost, 0);
      assert.equal(timedOut, 0);
    } finally {
      a.close();
      b.close();
      await new Promise<void>((resolve, reject) =>
        srv.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('simultaneous roll_dice: exactly one succeeds, the rest are rejected', async () => {
    const { sockets, a, code } = await newGame(['A', 'B']);
    const [, b] = sockets;
    try {
      const rolledP = waitFor<any>(a, 'dice_rolled');
      const errors: any[] = [];
      const onError = (e: any) => errors.push(e);
      a.on('error', onError);
      b.on('error', onError);

      // Same-tick: A rolls twice (same socket, ordered), B rolls out of turn.
      a.emit('roll_dice', { code });
      a.emit('roll_dice', { code });
      b.emit('roll_dice', { code });

      const rolled: any = await rolledP;
      assert.equal(rolled.player, 0);
      assert.equal(rolled.value, 6);

      await new Promise((r) => setTimeout(r, 400));
      assert.equal(errors.length, 2);
      assert.deepEqual(
        errors.map((e) => e.code).sort(),
        ['ALREADY_ROLLED', 'NOT_YOUR_TURN'],
      );
    } finally {
      closeAll(sockets);
    }
  });

  it('eliminated seats cannot act', async () => {
    const built = buildServer({
      diceFactory: () => () => 6,
      rules: fastRules({ livesPerPlayer: 1, diceTimeoutSec: 1, moveTimeoutSec: 1 }),
    });
    const srv: HttpServer = built.httpServer;
    await new Promise<void>((r) => srv.listen(0, r));
    const { port } = srv.address() as AddressInfo;
    const u = `http://127.0.0.1:${port}`;
    const a = ioClient(u);
    const b = ioClient(u);
    const c = ioClient(u);
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect'), waitFor(c, 'connect')]);
      a.emit('create_room', { playerName: 'A' });
      const created: any = await waitFor(a, 'room_created');
      b.emit('join_room', { code: created.code, playerName: 'B' });
      await waitFor(b, 'room_joined');
      c.emit('join_room', { code: created.code, playerName: 'C' });
      await waitFor(c, 'room_joined');

      const elimP = waitFor<any>(a, 'player_eliminated');
      const startedP = waitFor(a, 'game_started');
      a.emit('start_game', { code: created.code });
      await startedP;
      await elimP; // player 0 (socket a) is now eliminated

      const errP = waitFor<any>(a, 'error');
      a.emit('roll_dice', { code: created.code });
      const err: any = await errP;
      assert.equal(err.code, 'ELIMINATED');
    } finally {
      a.close();
      b.close();
      c.close();
      await new Promise<void>((resolve, reject) =>
        srv.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
