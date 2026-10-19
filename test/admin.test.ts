import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server as HttpServer } from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildServer } from '../src/server.js';
import { GameRecord } from '../src/models/GameRecord.js';

const ADMIN_TOKEN = 'test-admin-token';

describe('admin + economy routes (live DB)', () => {
  let mongod: MongoMemoryServer;
  let httpServer: HttpServer;
  let url: string;

  const adminHeaders = { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' };

  before(async () => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    const built = buildServer({});
    httpServer = built.httpServer;
    await new Promise<void>((r) => httpServer.listen(0, r));
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
    (globalThis as any).__testRooms = built.rooms;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((e) => (e ? reject(e) : resolve())),
    );
    await mongoose.disconnect();
    await mongod.stop();
    delete process.env.ADMIN_TOKEN;
  });

  it('returns 403 ADMIN_DISABLED when no admin token is configured', async () => {
    delete process.env.ADMIN_TOKEN;
    try {
      const res = await fetch(`${url}/api/admin/users`);
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { code: 'ADMIN_DISABLED' });
    } finally {
      process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    }
  });

  it('returns 403 FORBIDDEN on a wrong admin token', async () => {
    const res = await fetch(`${url}/api/admin/users`, {
      headers: { 'x-admin-token': 'wrong' },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { code: 'FORBIDDEN' });
  });

  it('identify is public and lists users with case-insensitive search', async () => {
    for (const [userId, displayName] of [
      ['alice', 'Alice'],
      ['bob', 'Bobby'],
    ] as const) {
      const res = await fetch(`${url}/api/users/identify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, displayName }),
      });
      assert.equal(res.status, 200);
      const body: any = await res.json();
      assert.equal(body.userId, userId);
      assert.equal(body.coins, 0);
    }

    const all: any = await (
      await fetch(`${url}/api/admin/users`, { headers: adminHeaders })
    ).json();
    assert.equal(all.users.length, 2);

    const hit: any = await (
      await fetch(`${url}/api/admin/users?search=ALIC`, { headers: adminHeaders })
    ).json();
    assert.equal(hit.users.length, 1);
    assert.equal(hit.users[0].userId, 'alice');

    const miss: any = await (
      await fetch(`${url}/api/admin/users?search=zzz`, { headers: adminHeaders })
    ).json();
    assert.equal(miss.users.length, 0);
  });

  it('grant flow credits coins and writes an audit ledger entry', async () => {
    let res = await fetch(`${url}/api/admin/grant`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ userId: 'alice', amount: 200, note: 'promo' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { userId: 'alice', coins: 200 });

    // Negative amount deducts.
    res = await fetch(`${url}/api/admin/grant`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ userId: 'alice', amount: -50 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { userId: 'alice', coins: 150 });

    // Overdraft is rejected with INSUFFICIENT_COINS.
    res = await fetch(`${url}/api/admin/grant`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ userId: 'alice', amount: -1000 }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { code: 'INSUFFICIENT_COINS' });

    // Zero amount is invalid.
    res = await fetch(`${url}/api/admin/grant`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ userId: 'alice', amount: 0 }),
    });
    assert.equal(res.status, 400);

    // Unknown user -> 404.
    res = await fetch(`${url}/api/admin/grant`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ userId: 'ghost', amount: 10 }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { code: 'USER_NOT_FOUND' });

    // Ledger shows grant then deduct, newest first, with audit meta.
    const ledger: any = await (
      await fetch(`${url}/api/admin/ledger?userId=alice`, { headers: adminHeaders })
    ).json();
    assert.equal(ledger.entries.length, 2);
    assert.equal(ledger.entries[0].reason, 'admin_deduct');
    assert.equal(ledger.entries[0].delta, -50);
    assert.equal(ledger.entries[0].balanceAfter, 150);
    assert.equal(ledger.entries[1].reason, 'admin_grant');
    assert.equal(ledger.entries[1].delta, 200);
    assert.equal(ledger.entries[1].balanceAfter, 200);
    assert.equal(ledger.entries[1].meta.note, 'promo');

    // userId is required on the ledger endpoint.
    const bad: any = await fetch(`${url}/api/admin/ledger`, { headers: adminHeaders });
    assert.equal(bad.status, 400);
  });

  it('wallet lookup and claim-daily work end to end', async () => {
    const w: any = await (await fetch(`${url}/api/wallet/bob`)).json();
    assert.equal(w.coins, 0);

    const missing = await fetch(`${url}/api/wallet/ghost`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { code: 'USER_NOT_FOUND' });

    const claim: any = await (
      await fetch(`${url}/api/wallet/bob/claim-daily`, { method: 'POST' })
    ).json();
    assert.equal(claim.claimed, true);
    assert.equal(claim.streakDays, 1);
    assert.equal(claim.reward, 50); // default table day 1

    const again: any = await (
      await fetch(`${url}/api/wallet/bob/claim-daily`, { method: 'POST' })
    ).json();
    assert.equal(again.claimed, false);
  });

  it('rewards PUT validates and round-trips through GET', async () => {
    const put = await fetch(`${url}/api/admin/rewards`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ rewards: [{ day: 3, coins: 300 }, { day: 1, coins: 10 }] }),
    });
    assert.equal(put.status, 200);
    // Response is sorted by day ascending.
    assert.deepEqual(await put.json(), {
      rewards: [
        { day: 1, coins: 10 },
        { day: 3, coins: 300 },
      ],
    });

    const get: any = await (
      await fetch(`${url}/api/admin/rewards`, { headers: adminHeaders })
    ).json();
    assert.deepEqual(get.rewards, [
      { day: 1, coins: 10 },
      { day: 3, coins: 300 },
    ]);

    // Duplicate days are rejected.
    const dup = await fetch(`${url}/api/admin/rewards`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ rewards: [{ day: 1, coins: 10 }, { day: 1, coins: 20 }] }),
    });
    assert.equal(dup.status, 400);

    // Negative coins and out-of-range days are rejected.
    for (const bad of [
      [{ day: 1, coins: -5 }],
      [{ day: 0, coins: 5 }],
      [{ day: 366, coins: 5 }],
    ]) {
      const r = await fetch(`${url}/api/admin/rewards`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ rewards: bad }),
      });
      assert.equal(r.status, 400);
    }
  });

  it('rooms endpoint reflects live in-memory rooms', async () => {
    const rooms = (globalThis as any).__testRooms;
    const before: any = await (
      await fetch(`${url}/api/admin/rooms`, { headers: adminHeaders })
    ).json();
    const n0 = before.rooms.length;

    const room = rooms.createRoom('sock1', 'Host', { entryFee: 25 });
    const after: any = await (
      await fetch(`${url}/api/admin/rooms`, { headers: adminHeaders })
    ).json();
    assert.equal(after.rooms.length, n0 + 1);
    const found = after.rooms.find((r: any) => r.code === room.code);
    assert.ok(found);
    assert.equal(found.entryFee, 25);
    assert.equal(found.status, 'waiting');
  });

  it('matches endpoint returns persisted game records newest first', async () => {
    await GameRecord.create({
      code: 'AAA111',
      numPlayers: 2,
      playerNames: ['A', 'B'],
      winner: 1,
      moves: [],
      startedAt: new Date(Date.now() - 1000),
      endedAt: new Date(),
    });
    const body: any = await (
      await fetch(`${url}/api/admin/matches?limit=5`, { headers: adminHeaders })
    ).json();
    assert.ok(Array.isArray(body.matches));
    assert.equal(body.matches[0].code, 'AAA111');
    assert.equal(body.matches[0].winner, 1);
  });
});
