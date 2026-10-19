import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server as HttpServer } from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { buildServer } from '../src/server.js';
import { RoomManager } from '../src/realtime/rooms.js';
import { addCoins, getWallet, identifyUser, walletPort } from '../src/economy/wallet.js';
import { LedgerEntry } from '../src/models/LedgerEntry.js';

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

describe('entry fees (live DB)', () => {
  let mongod: MongoMemoryServer;
  let httpServer: HttpServer;
  let url: string;

  before(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    const built = buildServer({ diceFactory: () => () => 6 });
    httpServer = built.httpServer;
    await new Promise<void>((r) => httpServer.listen(0, r));
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;

    await identifyUser('rich1', 'Rich One');
    await identifyUser('rich2', 'Rich Two');
    await identifyUser('poor', 'Poor');
    await addCoins('rich1', 1000, 'admin_grant');
    await addCoins('rich2', 1000, 'admin_grant');
    await addCoins('poor', 50, 'admin_grant');
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((e) => (e ? reject(e) : resolve())),
    );
    await mongoose.disconnect();
    await mongod.stop();
  });

  it('rejects invalid entry fees at room creation', () => {
    const mgr = new RoomManager(undefined, walletPort);
    for (const bad of [-1, 1.5, Number.NaN, '10' as any]) {
      assert.throws(
        () => mgr.createRoom('s', 'P', { entryFee: bad }),
        (e: Error) => e.message === 'INVALID_ENTRY_FEE',
      );
    }
    const ok = mgr.createRoom('s', 'P', { entryFee: 100 });
    assert.equal(ok.entryFee, 100);
    const free = mgr.createRoom('s', 'P');
    assert.equal(free.entryFee, 0);
  });

  it('startGame deducts the entry fee from every player wallet', async () => {
    const mgr = new RoomManager(undefined, walletPort);
    const room = mgr.createRoom('s1', 'A', { userId: 'rich1', entryFee: 100 });
    mgr.joinRoom(room.code, 's2', 'B', 'rich2');
    await mgr.startGame(room.code, 's1');
    assert.equal(room.status, 'playing');

    assert.equal((await getWallet('rich1'))!.coins, 900);
    assert.equal((await getWallet('rich2'))!.coins, 900);
    const entries = await LedgerEntry.find({ userId: 'rich1', reason: 'room_entry' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].delta, -100);
    assert.equal(entries[0].balanceAfter, 900);
    assert.equal((entries[0].meta as any).code, room.code);
  });

  it('refunds already-charged players when a seat cannot pay', async () => {
    const mgr = new RoomManager(undefined, walletPort);
    const room = mgr.createRoom('s1', 'A', { userId: 'rich1', entryFee: 100 });
    mgr.joinRoom(room.code, 's2', 'B', 'poor'); // only 50 coins
    await assert.rejects(
      () => mgr.startGame(room.code, 's1'),
      (e: Error) => e.message === 'INSUFFICIENT_COINS',
    );
    assert.equal(room.status, 'waiting'); // game never started

    // rich1 was charged then refunded; poor was never charged.
    assert.equal((await getWallet('rich1'))!.coins, 900);
    assert.equal((await getWallet('poor'))!.coins, 50);
    const refund = await LedgerEntry.findOne({
      userId: 'rich1',
      reason: 'room_entry_refund',
    });
    assert.ok(refund);
    assert.equal(refund.delta, 100);
    assert.equal(refund.balanceAfter, 900);
  });

  it('requires a linked userId on every seat for fee rooms', async () => {
    const mgr = new RoomManager(undefined, walletPort);
    const room = mgr.createRoom('s1', 'A', { userId: 'rich1', entryFee: 100 });
    mgr.joinRoom(room.code, 's2', 'B'); // no userId
    await assert.rejects(
      () => mgr.startGame(room.code, 's1'),
      (e: Error) => e.message === 'WALLET_REQUIRED',
    );
    assert.equal((await getWallet('rich1'))!.coins, 900); // untouched
  });

  it('requires a wallet when the fee is positive', async () => {
    const mgr = new RoomManager(); // no wallet injected
    const room = mgr.createRoom('s1', 'A', { userId: 'rich1', entryFee: 100 });
    mgr.joinRoom(room.code, 's2', 'B', 'rich2');
    await assert.rejects(
      () => mgr.startGame(room.code, 's1'),
      (e: Error) => e.message === 'DB_REQUIRED',
    );
  });

  it('awardPot credits the whole pot to the winner', async () => {
    const mgr = new RoomManager(undefined, walletPort);
    const room = mgr.createRoom('s1', 'A', { userId: 'rich1', entryFee: 100 });
    mgr.joinRoom(room.code, 's2', 'B', 'rich2');
    await mgr.startGame(room.code, 's1'); // 800 each now
    room.winner = 0; // pretend player 0 won
    await mgr.awardPot(room);
    assert.equal((await getWallet('rich1'))!.coins, 1000); // 800 + 200 pot
    assert.equal((await getWallet('rich2'))!.coins, 800);
    const win = await LedgerEntry.findOne({ userId: 'rich1', reason: 'room_win' });
    assert.ok(win);
    assert.equal(win.delta, 200);
    assert.equal(win.balanceAfter, 1000);
  });

  it('awardPot is a no-op without a winner, fee, or wallet', async () => {
    const mgr = new RoomManager(undefined, walletPort);
    const room = mgr.createRoom('s1', 'A', { userId: 'rich1', entryFee: 100 });
    await mgr.awardPot(room); // winner null -> nothing happens
    assert.equal((await getWallet('rich1'))!.coins, 1000);

    const free = mgr.createRoom('s1', 'A', { userId: 'rich1' });
    free.winner = 0;
    await mgr.awardPot(free); // entryFee 0 -> nothing happens
    assert.equal((await getWallet('rich1'))!.coins, 1000);

    const noWallet = new RoomManager();
    const r2 = noWallet.createRoom('s1', 'A', { userId: 'rich1', entryFee: 50 });
    r2.winner = 0;
    await noWallet.awardPot(r2); // no wallet -> nothing happens
    assert.equal((await getWallet('rich1'))!.coins, 1000);
  });

  it('socket: create/join/start with an entry fee deducts both wallets', async () => {
    const a = ioClient(url);
    const b = ioClient(url);
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);
      a.emit('create_room', { playerName: 'A', userId: 'rich1', entryFee: 100 });
      const created: any = await waitFor(a, 'room_created');
      assert.equal(created.state.entryFee, 100);

      b.emit('join_room', { code: created.code, playerName: 'B', userId: 'rich2' });
      await waitFor(b, 'room_joined');

      const started = waitFor(a, 'game_started');
      a.emit('start_game', { code: created.code });
      await started;

      assert.equal((await getWallet('rich1'))!.coins, 900);
      assert.equal((await getWallet('rich2'))!.coins, 700);
    } finally {
      a.close();
      b.close();
    }
  });

  it('socket: invalid entry fee and missing wallet surface as error events', async () => {
    const a = ioClient(url);
    const b = ioClient(url);
    try {
      await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);

      a.emit('create_room', { playerName: 'A', userId: 'rich1', entryFee: -5 });
      const badFee: any = await waitFor(a, 'error');
      assert.equal(badFee.code, 'INVALID_ENTRY_FEE');

      // Fee room where the joiner never linked a wallet.
      a.emit('create_room', { playerName: 'A', userId: 'rich1', entryFee: 100 });
      const created: any = await waitFor(a, 'room_created');
      b.emit('join_room', { code: created.code, playerName: 'B' });
      await waitFor(b, 'room_joined');
      a.emit('start_game', { code: created.code });
      const err: any = await waitFor(a, 'error');
      assert.equal(err.code, 'WALLET_REQUIRED');
      assert.equal((await getWallet('rich1'))!.coins, 900); // not charged
    } finally {
      a.close();
      b.close();
    }
  });
});
