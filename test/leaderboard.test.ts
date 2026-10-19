import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server as HttpServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { buildServer } from '../src/server.js';
import { identifyUser, getWallet } from '../src/economy/wallet.js';
import { MatchStats } from '../src/models/MatchStats.js';
import { RewardClaim } from '../src/models/RewardClaim.js';
import { periodFor, resetAtFor } from '../src/economy/leaderboard.js';
import { DEFAULT_RULES } from '../src/engine/rules.js';
import { todayUTC } from '../src/economy/streak.js';

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

async function pollFor<T>(fn: () => Promise<T | null>, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('pollFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function postJson(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('leaderboard + victory rewards (live DB)', () => {
  let mongod: MongoMemoryServer;
  let httpServer: HttpServer;
  let url: string;
  // /tmp is a 512MB tmpfs and mongod refuses index builds unless 512MB are
  // free — impossible there. This suite needs real indexes (the victory-claim
  // anti-duplicate IS the unique index), so the memory server gets a dbPath
  // on the persistent disk instead. Cleaned up in after().
  const mongoDataDir = path.join(os.homedir(), '.cache', 'ludo-test-mongo');

  before(async () => {
    process.env.ADMIN_TOKEN = 'test-admin-token';
    fs.rmSync(mongoDataDir, { recursive: true, force: true });
    fs.mkdirSync(mongoDataDir, { recursive: true });
    mongod = await MongoMemoryServer.create({ instance: { dbPath: mongoDataDir } });
    await mongoose.connect(mongod.getUri());
    // 1-life games with short timers: a game_over via elimination is quick.
    const built = buildServer({
      diceFactory: () => () => 6,
      rules: { ...DEFAULT_RULES, livesPerPlayer: 1, diceTimeoutSec: 0.5, moveTimeoutSec: 0.5 },
    });
    httpServer = built.httpServer;
    await new Promise<void>((r) => httpServer.listen(0, r));
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;

    await identifyUser('lb_p0', 'P Zero');
    await identifyUser('lb_p1', 'P One');
    await identifyUser('rw_user', 'Rewarder');
    // The victory-claim anti-duplicate relies on the unique index; make sure
    // it exists before the 409 test (mongoose builds indexes in background).
    await RewardClaim.syncIndexes();
    await MatchStats.syncIndexes();
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((e) => (e ? reject(e) : resolve())),
    );
    await mongoose.disconnect().catch(() => {});
    await mongod.stop();
    fs.rmSync(mongoDataDir, { recursive: true, force: true });
  });

  it('period keys are correct per scope (UTC)', () => {
    assert.equal(periodFor('daily', new Date('2026-10-19T12:00:00Z')), '2026-10-19');
    assert.equal(periodFor('weekly', new Date('2026-10-19T12:00:00Z')), '2026-W43'); // Monday
    assert.equal(periodFor('weekly', new Date('2026-10-18T12:00:00Z')), '2026-W42'); // Sunday
    assert.equal(periodFor('weekly', new Date('2021-01-01T12:00:00Z')), '2020-W53'); // ISO year boundary
    assert.equal(periodFor('monthly', new Date('2026-10-19T12:00:00Z')), '2026-10');
    assert.equal(periodFor('alltime', new Date('2026-10-19T12:00:00Z')), 'all');
  });

  it('resetAt points at the next period boundary', () => {
    assert.equal(
      resetAtFor('daily', new Date('2026-10-19T12:00:00Z')),
      '2026-10-20T00:00:00.000Z',
    );
    assert.equal(
      resetAtFor('weekly', new Date('2026-10-19T12:00:00Z')),
      '2026-10-26T00:00:00.000Z',
    );
    assert.equal(
      resetAtFor('monthly', new Date('2026-10-19T12:00:00Z')),
      '2026-11-01T00:00:00.000Z',
    );
    assert.equal(resetAtFor('alltime', new Date('2026-10-19T12:00:00Z')), null);
  });

  it('tie-break order: points, then wins, then win%, then userId', async () => {
    const docs = [
      // name, points, won, played
      ['u_win6', 100, 6, 6], // most wins at 100 pts -> rank 1
      ['u_aaa', 100, 5, 8], // 62.5% ; userId tie-break beats u_zzz
      ['u_zzz', 100, 5, 8], // 62.5%
      ['u_low', 100, 5, 10], // 50% -> after the 62.5% rows
      ['u_poor', 90, 9, 9], // fewer points -> last despite 9 wins
    ] as const;
    await MatchStats.insertMany(
      docs.map(([userId, points, matchesWon, matchesPlayed]) => ({
        userId,
        displayName: userId,
        scope: 'alltime',
        period: 'all',
        matchesPlayed,
        matchesWon,
        matchesLost: matchesPlayed - matchesWon,
        points,
      })),
    );

    const res = await fetch(`${url}/api/leaderboard?scope=alltime&limit=50`);
    assert.equal(res.status, 200);
    const board: any = await res.json();
    assert.equal(board.scope, 'alltime');
    assert.equal(board.period, 'all');
    assert.equal(board.resetAt, null);
    const order = board.entries.map((e: any) => e.userId);
    assert.deepEqual(order, ['u_win6', 'u_aaa', 'u_zzz', 'u_low', 'u_poor']);
    assert.deepEqual(
      board.entries.map((e: any) => e.rank),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      board.entries.map((e: any) => e.winPct),
      [100, 62.5, 62.5, 50, 100],
    );
  });

  it('game_over feeds the leaderboard with win/loss points across scopes', async () => {
    const a = ioClient(url);
    const b = ioClient(url);
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
      a.emit('create_room', { playerName: 'P Zero', userId: 'lb_p0' });
      const created: any = await waitFor(a, 'room_created');
      b.emit('join_room', { code: created.code, playerName: 'P One', userId: 'lb_p1' });
      await waitFor(b, 'room_joined');

      const overP = waitFor<any>(a, 'game_over');
      a.emit('start_game', { code: created.code });
      const over: any = await overP;
      assert.equal(over.reason, 'elimination');
      assert.equal(over.winner, 1); // lb_p1: lb_p0 timed out with 1 life

      // The persist hook folds the result into every scope.
      const w = await pollFor(async () =>
        MatchStats.findOne({ userId: 'lb_p1', scope: 'alltime', period: 'all' }).lean(),
      );
      assert.equal(w!.matchesPlayed, 1);
      assert.equal(w!.matchesWon, 1);
      assert.equal(w!.matchesLost, 0);
      assert.equal(w!.points, DEFAULT_RULES.winPoints);
      assert.equal(w!.displayName, 'P One'); // refreshed from the room

      const l = await pollFor(async () =>
        MatchStats.findOne({ userId: 'lb_p0', scope: 'alltime', period: 'all' }).lean(),
      );
      assert.equal(l!.matchesPlayed, 1);
      assert.equal(l!.matchesWon, 0);
      assert.equal(l!.matchesLost, 1);
      assert.equal(l!.points, DEFAULT_RULES.lossPoints);

      const daily = await MatchStats.findOne({
        userId: 'lb_p1',
        scope: 'daily',
        period: todayUTC(),
      });
      assert.ok(daily, 'expected a daily-scope row for today (UTC)');
      const weekly = await MatchStats.findOne({
        userId: 'lb_p1',
        scope: 'weekly',
        period: { $regex: /^\d{4}-W\d{2}$/ },
      });
      assert.ok(weekly, 'expected a weekly-scope row with an ISO week period');
    } finally {
      a.close();
      b.close();
    }
  });

  it('friends board returns global ranks for the requested users', async () => {
    const full: any = await (await fetch(`${url}/api/leaderboard?scope=alltime&limit=50`)).json();
    const friends: any = await (
      await fetch(`${url}/api/leaderboard/friends?scope=alltime&userIds=lb_p0,lb_p1`)
    ).json();
    assert.equal(friends.entries.length, 2);
    for (const e of friends.entries) {
      const global = full.entries.find((g: any) => g.userId === e.userId);
      assert.ok(global, `expected ${e.userId} on the full board`);
      assert.equal(e.rank, global.rank); // rank is global, not within the friend set
    }
    // Unknown ids are simply absent.
    const empty: any = await (
      await fetch(`${url}/api/leaderboard/friends?scope=alltime&userIds=nobody`)
    ).json();
    assert.deepEqual(empty.entries, []);
  });

  it('profile aggregates wallet + alltime stats', async () => {
    const res = await fetch(`${url}/api/profile/lb_p1`);
    assert.equal(res.status, 200);
    const p: any = await res.json();
    assert.equal(p.userId, 'lb_p1');
    assert.equal(p.displayName, 'P One');
    assert.equal(p.coins, 0);
    assert.equal(p.streakDays, 0);
    assert.equal(p.matchesPlayed, 1);
    assert.equal(p.matchesWon, 1);
    assert.equal(p.winPct, 100);
    assert.equal(p.points, DEFAULT_RULES.winPoints);
    // 100 pts / 1 win / 100%: behind u_win6, u_aaa, u_zzz, u_low -> rank 5.
    assert.equal(p.rank, 5);

    const loser: any = await (await fetch(`${url}/api/profile/lb_p0`)).json();
    assert.equal(loser.matchesWon, 0);
    assert.equal(loser.winPct, 0);
    assert.equal(loser.points, DEFAULT_RULES.lossPoints);

    assert.equal((await fetch(`${url}/api/profile/nobody`)).status, 404);
  });

  it('admin leaderboard endpoint mirrors the public board', async () => {
    const res = await fetch(`${url}/api/admin/leaderboard?scope=alltime&limit=3`, {
      headers: { 'x-admin-token': 'test-admin-token' },
    });
    assert.equal(res.status, 200);
    const board: any = await res.json();
    assert.equal(board.entries.length, 3);
    assert.equal(board.entries[0].userId, 'u_win6');
    assert.equal(
      (await fetch(`${url}/api/admin/leaderboard`, { headers: {} })).status,
      403,
    );
  });

  it('victory claim credits once; a second claim for the same match is 409', async () => {
    const first = await postJson(url, '/api/rewards/claim', {
      userId: 'rw_user',
      type: 'victory',
      matchCode: 'MATCH-1',
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.claimed, true);
    assert.equal(first.body.coins, DEFAULT_RULES.victoryBonusCoins);
    assert.equal(first.body.balance, DEFAULT_RULES.victoryBonusCoins);

    const dup = await postJson(url, '/api/rewards/claim', {
      userId: 'rw_user',
      type: 'victory',
      matchCode: 'MATCH-1',
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'ALREADY_CLAIMED');

    // No double credit.
    assert.equal((await getWallet('rw_user'))!.coins, DEFAULT_RULES.victoryBonusCoins);

    // A different match is a different claim.
    const other = await postJson(url, '/api/rewards/claim', {
      userId: 'rw_user',
      type: 'victory',
      matchCode: 'MATCH-2',
    });
    assert.equal(other.status, 200);
    assert.equal(other.body.balance, DEFAULT_RULES.victoryBonusCoins * 2);

    // Validation.
    assert.equal(
      (await postJson(url, '/api/rewards/claim', { type: 'victory', matchCode: 'M' })).status,
      400,
    );
    assert.equal(
      (
        await postJson(url, '/api/rewards/claim', {
          userId: 'rw_user',
          type: 'daily',
          matchCode: 'M',
        })
      ).status,
      400,
    );
    assert.equal(
      (await postJson(url, '/api/rewards/claim', { userId: 'rw_user', type: 'victory' })).status,
      400,
    );
  });

  it('rewards history lists granted rewards newest-first', async () => {
    // A daily claim is also recorded into RewardClaim (history unity).
    const daily = await postJson(url, `/api/wallet/rw_user/claim-daily`, {});
    assert.equal(daily.status, 200);
    assert.equal(daily.body.claimed, true);
    const claimRows = await RewardClaim.find({ userId: 'rw_user', type: 'daily' });
    assert.equal(claimRows.length, 1);
    assert.equal(claimRows[0].key, todayUTC());

    const res = await fetch(`${url}/api/rewards/history/rw_user`);
    assert.equal(res.status, 200);
    const history: any = await res.json();
    const types = history.rewards.map((r: any) => r.type);
    assert.ok(types.includes('daily'), 'expected a daily entry');
    assert.equal(
      types.filter((t: string) => t === 'victory').length,
      2,
      'expected two victory entries',
    );
    for (const r of history.rewards) {
      assert.ok(typeof r.coins === 'number' && r.coins > 0);
      assert.ok(typeof r.at === 'string');
    }
    const ats = history.rewards.map((r: any) => r.at);
    assert.deepEqual([...ats].sort().reverse(), ats); // newest first
  });

  it('leaderboard, profile and rewards answer 503 without a database', async () => {
    await mongoose.disconnect();
    const checks: Array<[string, { method?: string; body?: unknown }]> = [
      ['/api/leaderboard', {}],
      ['/api/leaderboard/friends?userIds=a', {}],
      ['/api/profile/lb_p1', {}],
      ['/api/rewards/history/rw_user', {}],
      ['/api/rewards/claim', { method: 'POST', body: { userId: 'x', type: 'victory', matchCode: 'M' } }],
    ];
    for (const [path, opts] of checks) {
      const res = await fetch(`${url}${path}`, {
        method: opts.method ?? 'GET',
        headers: { 'content-type': 'application/json' },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      assert.equal(res.status, 503, `expected 503 for ${path}`);
      assert.equal(((await res.json()) as any).code, 'DB_REQUIRED');
    }
    // Admin surface keeps its own DB guard too.
    const admin = await fetch(`${url}/api/admin/leaderboard`, {
      headers: { 'x-admin-token': 'test-admin-token' },
    });
    assert.equal(admin.status, 503);
  });
});
