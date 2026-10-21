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

async function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  return res.json();
}

describe('matchmaking queue', () => {
  let httpServer: HttpServer;
  let url: string;

  before(async () => {
    const built = buildServer({});
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

  it('join without userId is rejected', async () => {
    const { status, json } = await postJson(`${url}/api/matchmaking/join`, {});
    assert.equal(status, 400);
    assert.equal(json.code, 'USER_ID_REQUIRED');
  });

  it('first player waits, second player matches both', async () => {
    const a = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-a',
      playerName: 'Asha',
    });
    assert.equal(a.json.status, 'waiting');

    const b = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-b',
      playerName: 'Bala',
    });
    assert.equal(b.json.status, 'matched');
    assert.match(b.json.code, /^[A-Z2-9]{6}$/);

    // The first player now sees the same code when polling.
    const sa = await getJson(`${url}/api/matchmaking/status/mm-a`);
    assert.equal(sa.status, 'matched');
    assert.equal(sa.code, b.json.code);
  });

  it('join is idempotent while waiting', async () => {
    const first = await postJson(`${url}/api/matchmaking/join`, { userId: 'mm-c' });
    assert.equal(first.json.status, 'waiting');
    const second = await postJson(`${url}/api/matchmaking/join`, { userId: 'mm-c' });
    assert.equal(second.json.status, 'waiting');
    const st = await getJson(`${url}/api/matchmaking/status/mm-c`);
    assert.equal(st.status, 'waiting');
  });

  it('unknown user reports not_in_queue', async () => {
    const st = await getJson(`${url}/api/matchmaking/status/mm-nobody`);
    assert.equal(st.status, 'not_in_queue');
  });

  it('leave removes the player from the queue', async () => {
    await postJson(`${url}/api/matchmaking/join`, { userId: 'mm-d' });
    await postJson(`${url}/api/matchmaking/leave`, { userId: 'mm-d' });
    const st = await getJson(`${url}/api/matchmaking/status/mm-d`);
    assert.equal(st.status, 'not_in_queue');
  });

  it('matched players can join the room via socket without duplicate seats', async () => {
    const a = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-e',
      playerName: 'Esha',
    });
    assert.equal(a.json.status, 'waiting');
    const b = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-f',
      playerName: 'Farid',
    });
    assert.equal(b.json.status, 'matched');
    const code = b.json.code as string;

    const sa = ioClient(url);
    const sb = ioClient(url);
    try {
      await Promise.all([waitFor(sa, 'connect'), waitFor(sb, 'connect')]);
      sa.emit('join_room', { code, playerName: 'Esha', userId: 'mm-e' });
      const ja: any = await waitFor(sa, 'room_joined');
      sb.emit('join_room', { code, playerName: 'Farid', userId: 'mm-f' });
      const jb: any = await waitFor(sb, 'room_joined');
      // Exactly 2 seats — the pre-created matchmaking seat was claimed, not duplicated.
      assert.equal(ja.state.players.length, 1);
      assert.equal(jb.state.players.length, 2);
      const ids = jb.state.players.map((p: any) => p.name).sort();
      assert.deepEqual(ids, ['Esha', 'Farid']);
    } finally {
      sa.close();
      sb.close();
    }
  });

  it('rejects an invalid playerCount', async () => {
    const { status, json } = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-bad-count',
      playerCount: 3,
    });
    assert.equal(status, 400);
    assert.equal(json.code, 'INVALID_PLAYER_COUNT');
  });

  it('rejects an invalid entryFee', async () => {
    const { status, json } = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-bad-fee',
      entryFee: -5,
    });
    assert.equal(status, 400);
    assert.equal(json.code, 'INVALID_ENTRY_FEE');
  });

  it('queues are bucketed by entry fee', async () => {
    const free = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-free',
      playerName: 'Free',
      entryFee: 0,
    });
    assert.equal(free.json.status, 'waiting');
    // A fee-paying player must NOT be matched with the free player.
    const paid = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-paid',
      playerName: 'Paid',
      entryFee: 10,
    });
    assert.equal(paid.json.status, 'waiting');
    // A second fee-10 player matches the first fee-10 player.
    const paid2 = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-paid2',
      playerName: 'PaidTwo',
      entryFee: 10,
    });
    assert.equal(paid2.json.status, 'matched');
    const stPaid = await getJson(`${url}/api/matchmaking/status/mm-paid`);
    assert.equal(stPaid.status, 'matched');
    assert.equal(stPaid.code, paid2.json.code);
    // The free player is still waiting for another free player.
    const stFree = await getJson(`${url}/api/matchmaking/status/mm-free`);
    assert.equal(stFree.status, 'waiting');
    await postJson(`${url}/api/matchmaking/leave`, { userId: 'mm-free' });
  });

  it('4-player bucket fills only at four players', async () => {
    const ids = ['mm-g1', 'mm-g2', 'mm-g3'];
    for (const id of ids) {
      const r = await postJson(`${url}/api/matchmaking/join`, {
        userId: id,
        playerName: id,
        playerCount: 4,
      });
      assert.equal(r.json.status, 'waiting');
    }
    const fourth = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-g4',
      playerName: 'mm-g4',
      playerCount: 4,
    });
    assert.equal(fourth.json.status, 'matched');
    assert.match(fourth.json.code, /^[A-Z2-9]{6}$/);
    for (const id of [...ids, 'mm-g4']) {
      const st = await getJson(`${url}/api/matchmaking/status/${id}`);
      assert.equal(st.status, 'matched');
      assert.equal(st.code, fourth.json.code);
    }
    // The room was created with 4 expected seats and the default (free) fee.
    const room = await getJson(`${url}/api/rooms/${fourth.json.code}`);
    assert.equal(room.playerCount, 1); // host reservation only, until sockets join
    assert.equal(room.status, 'waiting');
  });

  it('4-player match auto-starts when all four join via socket', async () => {
    const ids = ['mm-h1', 'mm-h2', 'mm-h3', 'mm-h4'];
    let code = '';
    for (const id of ids) {
      const r = await postJson(`${url}/api/matchmaking/join`, {
        userId: id,
        playerName: id,
        playerCount: 4,
      });
      if (r.json.code) code = r.json.code as string;
    }
    assert.match(code, /^[A-Z2-9]{6}$/);

    const sockets = ids.map(() => ioClient(url));
    try {
      await Promise.all(sockets.map((s) => waitFor(s, 'connect')));
      const started = waitFor<any>(sockets[0], 'game_started');
      for (let i = 0; i < ids.length; i++) {
        sockets[i].emit('join_room', { code, playerName: ids[i], userId: ids[i] });
        await waitFor(sockets[i], 'room_joined');
      }
      const gs = await started;
      assert.equal(gs.state.status, 'playing');
      assert.equal(gs.state.players.length, 4);
    } finally {
      sockets.forEach((s) => s.close());
    }
  });

  it('2-player match auto-starts when both join via socket', async () => {
    const a = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-i1',
      playerName: 'Ira',
    });
    assert.equal(a.json.status, 'waiting');
    const b = await postJson(`${url}/api/matchmaking/join`, {
      userId: 'mm-i2',
      playerName: 'Ivan',
    });
    assert.equal(b.json.status, 'matched');
    const code = b.json.code as string;

    const sa = ioClient(url);
    const sb = ioClient(url);
    try {
      await Promise.all([waitFor(sa, 'connect'), waitFor(sb, 'connect')]);
      const started = waitFor<any>(sa, 'game_started');
      sa.emit('join_room', { code, playerName: 'Ira', userId: 'mm-i1' });
      await waitFor(sa, 'room_joined');
      sb.emit('join_room', { code, playerName: 'Ivan', userId: 'mm-i2' });
      await waitFor(sb, 'room_joined');
      const gs = await started;
      assert.equal(gs.state.status, 'playing');
      assert.equal(gs.state.players.length, 2);
    } finally {
      sa.close();
      sb.close();
    }
  });
});
