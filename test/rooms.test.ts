import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server as HttpServer } from 'node:http';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { buildServer } from '../src/server.js';

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

describe('realtime rooms (socket.io)', () => {
  let httpServer: HttpServer;
  let url: string;

  before(async () => {
    // Deterministic dice: always 6, so the rolling player can always move.
    const built = buildServer({ diceFactory: () => () => 6 });
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

  it('create -> join -> start -> roll -> move works over real sockets', async () => {
    const a = ioClient(url);
    const b = ioClient(url);
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);

      a.emit('create_room', { playerName: 'Asha' });
      const created: any = await waitFor(a, 'room_created');
      assert.match(created.code, /^[A-Z2-9]{6}$/);
      assert.equal(created.state.players.length, 1);
      assert.equal(created.state.status, 'waiting');

      // Host cannot start a 1-player game.
      a.emit('start_game', { code: created.code });
      const startErr: any = await waitFor(a, 'error');
      assert.equal(startErr.code, 'NEED_MORE_PLAYERS');

      const sawJoin = waitFor(a, 'player_joined');
      b.emit('join_room', { code: created.code, playerName: 'Bala' });
      const joined: any = await waitFor(b, 'room_joined');
      assert.equal(joined.state.players.length, 2);
      await sawJoin;

      // Rolling before the game starts is rejected.
      b.emit('roll_dice', { code: created.code });
      const notStarted: any = await waitFor(b, 'error');
      assert.equal(notStarted.code, 'GAME_NOT_STARTED');

      const startedA = waitFor(a, 'game_started');
      const startedB = waitFor(b, 'game_started');
      a.emit('start_game', { code: created.code });
      const started: any = await startedA;
      await startedB;
      assert.equal(started.state.status, 'playing');
      assert.equal(started.state.game.numPlayers, 2);
      assert.equal(started.state.game.currentPlayer, 0);

      // Out-of-turn roll is rejected.
      b.emit('roll_dice', { code: created.code });
      const turnErr: any = await waitFor(b, 'error');
      assert.equal(turnErr.code, 'NOT_YOUR_TURN');

      // Host rolls the fixed 6 and moves token 0 out of base.
      a.emit('roll_dice', { code: created.code });
      const rolled: any = await waitFor(a, 'dice_rolled');
      assert.equal(rolled.player, 0);
      assert.equal(rolled.value, 6);
      assert.deepEqual(rolled.moves, [0, 1, 2, 3]);

      const movedA = waitFor(a, 'token_moved');
      const movedB = waitFor(b, 'token_moved');
      a.emit('move_token', { code: created.code, tokenIndex: 0 });
      const moved: any = await movedA;
      await movedB;
      assert.equal(moved.outcome.to, 0);
      assert.equal(moved.outcome.extraTurn, true);
      assert.equal(moved.state.game.tokens[0][0], 0);
      assert.equal(moved.state.game.currentPlayer, 0); // extra turn

      // REST room info + health endpoints.
      const infoRes = await fetch(`${url}/api/rooms/${created.code}`);
      assert.equal(infoRes.status, 200);
      const info: any = await infoRes.json();
      assert.equal(info.playerCount, 2);
      assert.deepEqual(info.players, ['Asha', 'Bala']);

      const health: any = await (await fetch(`${url}/health`)).json();
      assert.equal(health.ok, true);
      assert.equal(health.db, false); // no MongoDB configured in tests
      assert.equal((await fetch(`${url}/api/rooms/NOPE00`)).status, 404);
    } finally {
      a.close();
      b.close();
    }
  });

  it('rejects joining an unknown room code', async () => {
    const c = ioClient(url);
    try {
      await waitFor(c, 'connect');
      c.emit('join_room', { code: 'ZZZZZZ', playerName: 'X' });
      const err: any = await waitFor(c, 'error');
      assert.equal(err.code, 'ROOM_NOT_FOUND');
    } finally {
      c.close();
    }
  });

  it('last connected player wins when opponents disconnect mid-game', async () => {
    const a = ioClient(url);
    const b = ioClient(url);
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
      a.emit('create_room', { playerName: 'A' });
      const created: any = await waitFor(a, 'room_created');
      b.emit('join_room', { code: created.code, playerName: 'B' });
      await waitFor(b, 'room_joined');
      const started = waitFor(b, 'game_started');
      a.emit('start_game', { code: created.code });
      await started;

      const over = waitFor(b, 'game_over');
      a.close(); // host (player 0) disconnects mid-game
      const result: any = await over;
      assert.equal(result.winner, 1);
      assert.equal(result.reason, 'opponent_left');
      assert.equal(result.state.status, 'finished');
    } finally {
      a.close();
      b.close();
    }
  });

  it('AI takes over the turn of a disconnected player so the game continues', async () => {
    const a = ioClient(url);
    const b = ioClient(url);
    const c = ioClient(url);
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect'), waitFor(c, 'connect')]);
      a.emit('create_room', { playerName: 'A' });
      const created: any = await waitFor(a, 'room_created');
      b.emit('join_room', { code: created.code, playerName: 'B' });
      await waitFor(b, 'room_joined');
      c.emit('join_room', { code: created.code, playerName: 'C' });
      await waitFor(c, 'room_joined');
      const started = waitFor(b, 'game_started');
      a.emit('start_game', { code: created.code });
      await started;

      const autoEvents: any[] = [];
      let lastState: any = null;
      b.on('dice_rolled', (d: any) => {
        if (d.auto) autoEvents.push(d);
        lastState = d.state;
      });
      b.on('token_moved', (d: any) => {
        if (d.auto) autoEvents.push(d);
        lastState = d.state;
      });
      b.on('turn_changed', (d: any) => {
        lastState = d.state;
      });

      const left = waitFor(b, 'player_left');
      a.close(); // host was the current player -> AI takes over
      await left;
      await new Promise((r) => setTimeout(r, 1000)); // let the autoplay flurry flush

      assert.ok(autoEvents.length > 0, 'expected AI autoplay events for the disconnected player');
      assert.ok(autoEvents.every((e) => e.auto === true));
      assert.ok(lastState, 'expected state updates');
      assert.equal(lastState.status, 'playing');
      assert.equal(
        lastState.game.currentPlayer,
        1,
        'after the AI finishes the disconnected turn, play passes to B',
      );
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });
});
