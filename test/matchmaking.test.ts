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
});
