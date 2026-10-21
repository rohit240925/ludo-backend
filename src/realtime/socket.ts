import { Server, Socket } from 'socket.io';
import { MoveOutcome, chooseAiMove } from '../engine/ludo.js';
import { Room, RoomManager, TurnPhase, publicState } from './rooms.js';

/** Best-effort persistence hook (no-op when MongoDB is not configured). */
export type PersistGame = (room: Room) => Promise<void>;

export type GameOverReason = 'win' | 'opponent_left' | 'elimination';

interface RoomRef {
  code?: string;
  playerName?: string;
  tokenIndex?: number;
  userId?: string;
  entryFee?: number;
}

/**
 * Actions landing within this grace period after the deadline are still
 * honored — it absorbs network jitter. Anything later runs the timeout
 * path instead of the player's action.
 */
const TIMEOUT_GRACE_MS = 500;

export function attachSocket(io: Server, rooms: RoomManager, persist: PersistGame): void {
  const stateOf = (room: Room) => publicState(room);
  const rules = rooms.rules;
  /** socket.id -> set of room codes it has joined (deterministic; independent of socket.io internals). */
  const membership = new Map<string, Set<string>>();
  const track = (socketId: string, code: string) => {
    if (!membership.has(socketId)) membership.set(socketId, new Set());
    membership.get(socketId)!.add(code);
  };
  const untrack = (socketId: string, code: string) => membership.get(socketId)?.delete(code);

  /** room.code -> pending turn-timeout handle. Lives here (not on Room) so RoomManager stays timer-free. */
  const timers = new Map<string, NodeJS.Timeout>();

  /** Rooms whose matchmaking auto-start is currently in flight (double-join guard). */
  const autoStarting = new Set<string>();

  function emitError(socket: Socket, code: string, message?: string): void {
    socket.emit('error', { code, message: message ?? code });
  }

  function disarmTimer(room: Room): void {
    const t = timers.get(room.code);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(room.code);
    }
  }

  /**
   * Start the server-authoritative clock for a phase. Emits `timer_started`
   * so clients can render the countdown from the server deadline
   * (remaining = deadlineAt - Date.now()).
   */
  function armTimer(room: Room, phase: TurnPhase): void {
    const g = room.game;
    if (!g || room.status !== 'playing' || g.winner !== null) {
      disarmTimer(room);
      room.phase = null;
      room.deadlineAt = null;
      return;
    }
    disarmTimer(room);
    const secs = Math.max(0, phase === 'roll' ? rules.diceTimeoutSec : rules.moveTimeoutSec);
    room.phase = phase;
    room.deadlineAt = Date.now() + secs * 1000;
    room.turnNonce += 1;
    room.timeoutFired = false;
    const nonce = room.turnNonce;
    timers.set(room.code, setTimeout(() => onTimeout(room, nonce), secs * 1000));
    io.to(room.code).emit('timer_started', {
      phase,
      deadlineAt: room.deadlineAt,
      player: g.currentPlayer,
      state: stateOf(room),
    });
  }

  /** Skip seats that were eliminated (lives hit zero). Safety net; the turn normally never lands on them. */
  function skipEliminated(room: Room): void {
    const g = room.game!;
    let guard = 0;
    while (room.players[g.currentPlayer].eliminated && guard++ < g.numPlayers) {
      g.currentPlayer = (g.currentPlayer + 1) % g.numPlayers;
    }
  }

  /**
   * Give the current seat its clock when a human sits there, otherwise leave
   * the clock disarmed. Never starts AI play itself (no recursion).
   */
  function settleSeat(room: Room): void {
    const g = room.game;
    if (!g || room.status !== 'playing' || g.winner !== null) {
      disarmTimer(room);
      room.phase = null;
      room.deadlineAt = null;
      return;
    }
    skipEliminated(room);
    if (room.players[g.currentPlayer].connected) {
      armTimer(room, 'roll');
    } else {
      disarmTimer(room);
      room.phase = null;
      room.deadlineAt = null;
    }
  }

  /**
   * Settle the current seat: give a connected human their clock, or let the
   * engine AI play a disconnected seat's turn immediately (no timers for AI).
   */
  function beginTurn(room: Room): void {
    const g = room.game;
    if (!g || room.status !== 'playing' || g.winner !== null) {
      disarmTimer(room);
      room.phase = null;
      room.deadlineAt = null;
      return;
    }
    skipEliminated(room);
    if (!room.players[g.currentPlayer].connected) {
      disarmTimer(room);
      room.phase = null;
      room.deadlineAt = null;
      playDisconnectedTurns(room); // arms the clock for whoever is next
      return;
    }
    armTimer(room, 'roll');
  }

  /** True when the action arrived too late: run the timeout path instead. */
  function isLate(room: Room): boolean {
    return room.deadlineAt !== null && Date.now() > room.deadlineAt + TIMEOUT_GRACE_MS;
  }

  /**
   * Server-clock timeout for a turn phase. Exactly-once per nonce
   * (RoomManager.applyTimeout enforces it): deducts exactly one life,
   * eliminates at zero, and either ends the game or passes the turn.
   */
  function onTimeout(room: Room, nonce: number): void {
    timers.delete(room.code);
    const out = rooms.applyTimeout(room, nonce);
    if (!out.applied) return;
    io.to(room.code).emit('lives_changed', {
      player: out.player,
      lives: out.livesLeft,
      state: stateOf(room),
    });
    io.to(room.code).emit('turn_timeout', {
      player: out.player,
      phase: out.phase,
      livesLeft: out.livesLeft,
      state: stateOf(room),
    });
    if (out.eliminated) {
      io.to(room.code).emit('player_eliminated', {
        player: out.player,
        state: stateOf(room),
      });
    }
    if (room.status === 'finished') {
      // Elimination left a single seat standing — they take the game.
      rooms.awardPot(room).catch(() => {});
      finishGame(room, 'elimination');
      return;
    }
    io.to(room.code).emit('turn_changed', {
      currentPlayer: room.game!.currentPlayer,
      reason: 'timeout',
      auto: false,
      state: stateOf(room),
    });
    beginTurn(room);
  }

  function finishGame(room: Room, reason: GameOverReason): void {
    disarmTimer(room);
    room.phase = null;
    room.deadlineAt = null;
    room.status = 'finished';
    io.to(room.code).emit('game_over', {
      winner: room.winner,
      reason,
      state: stateOf(room),
    });
    persist(room).catch(() => {});
  }

  function doRoll(room: Room, playerIdx: number, auto: boolean): void {
    const g = room.game!;
    const value = g.roll();
    const moves = g.movableTokens();
    io.to(room.code).emit('dice_rolled', {
      player: playerIdx, value, moves, auto, state: stateOf(room),
    });
    if (moves.length === 0) {
      // Auto-pass: the roll had no legal moves. This never costs a life —
      // only a missed server timer does.
      g.passTurn();
      io.to(room.code).emit('turn_changed', {
        currentPlayer: g.currentPlayer, reason: 'no_moves', auto, state: stateOf(room),
      });
    }
  }

  function doMove(room: Room, playerIdx: number, tokenIndex: number, auto: boolean): MoveOutcome {
    const g = room.game!;
    const outcome = g.move(tokenIndex);
    rooms.recordMove(room, {
      player: outcome.player,
      tokenIndex: outcome.tokenIndex,
      roll: outcome.roll,
      from: outcome.from,
      to: outcome.to,
      captured: outcome.captured.length,
    });
    io.to(room.code).emit('token_moved', { outcome, auto, state: stateOf(room) });
    if (outcome.forfeited) {
      io.to(room.code).emit('turn_changed', {
        currentPlayer: g.currentPlayer, reason: 'three_sixes', auto, state: stateOf(room),
      });
    }
    if (outcome.winner !== null) {
      room.winner = outcome.winner;
      // Best-effort: pay the entry-fee pot to the winner's coin account.
      // awardPot logs internally and never throws, so game_over always fires.
      rooms.awardPot(room).catch(() => {});
      finishGame(room, 'win');
    }
    return outcome;
  }

  /**
   * The engine AI plays turns for disconnected players so a game never
   * stalls. AI turns are acted immediately — no timers — and when play
   * returns to a connected seat, that seat gets a fresh roll clock.
   */
  function playDisconnectedTurns(room: Room): void {
    const g = room.game;
    if (!g) return;
    let guard = 0;
    let acted = false;
    while (
      room.status === 'playing' &&
      g.winner === null &&
      !room.players[g.currentPlayer].eliminated &&
      !room.players[g.currentPlayer].connected &&
      guard++ < 500
    ) {
      acted = true;
      const idx = g.currentPlayer;
      if (g.lastRoll === null) {
        doRoll(room, idx, true);
      } else {
        const mv = chooseAiMove(g);
        if (mv === null) {
          g.passTurn();
          io.to(room.code).emit('turn_changed', {
            currentPlayer: g.currentPlayer, reason: 'no_moves', auto: true, state: stateOf(room),
          });
        } else {
          doMove(room, idx, mv, true);
        }
      }
    }
    if (acted && room.status === 'playing' && g.winner === null) {
      // Play is back with a human seat (or the game just ended): the next
      // connected seat starts a fresh roll phase with its own clock.
      settleSeat(room);
    }
  }

  function getRoom(code: string | undefined, socket: Socket): Room | null {
    const room = code ? rooms.get(code) : undefined;
    if (!room) {
      emitError(socket, 'ROOM_NOT_FOUND', 'room not found');
      return null;
    }
    return room;
  }

  function handleLeave(socket: Socket, onlyCode?: string): void {
    const codes = onlyCode
      ? [onlyCode.toUpperCase()]
      : [...(membership.get(socket.id) ?? [])];
    for (const code of codes) {
      const room = rooms.get(code);
      const wasFinished = room?.status === 'finished';
      const leaver = room?.players.find((p) => p.id === socket.id);
      const updated = rooms.removePlayer(code, socket.id);
      untrack(socket.id, code);
      socket.leave(code);
      if (!updated) {
        if (room) disarmTimer(room);
        io.to(code).emit('room_closed', { code });
        continue;
      }
      io.to(code).emit('player_left', {
        playerId: socket.id,
        name: leaver?.name ?? null,
        state: stateOf(updated),
      });
      if (!wasFinished && updated.status === 'finished' && updated.winner !== null) {
        // Someone just won by default (last player standing).
        finishGame(updated, 'opponent_left');
      } else if (updated.status === 'playing') {
        playDisconnectedTurns(updated);
      }
    }
  }

  io.on('connection', (socket: Socket) => {
    socket.on('create_room', (data: RoomRef) => {
      try {
        const room = rooms.createRoom(socket.id, data?.playerName ?? 'Player 1', {
          userId: data?.userId,
          entryFee: data?.entryFee,
        });
        socket.join(room.code);
        track(socket.id, room.code);
        socket.emit('room_created', { code: room.code, state: stateOf(room) });
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === 'INVALID_ENTRY_FEE') emitError(socket, 'INVALID_ENTRY_FEE');
        else emitError(socket, 'CREATE_FAILED', msg);
      }
    });

    socket.on('join_room', async (data: RoomRef) => {
      try {
        const room = rooms.joinRoom(
          data?.code ?? '',
          socket.id,
          data?.playerName ?? 'Player',
          data?.userId,
        );
        socket.join(room.code);
        track(socket.id, room.code);
        const seat = room.players.findIndex((p) => p.id === socket.id);
        socket.emit('room_joined', { code: room.code, seat, state: stateOf(room) });
        socket.to(room.code).emit('player_joined', {
          name: room.players[room.players.length - 1].name,
          state: stateOf(room),
        });
        // Matchmaking rooms have no human host to press Start: once every
        // expected seat is filled and connected, start the game for them.
        if (
          room.expectedPlayers !== undefined &&
          room.status === 'waiting' &&
          !autoStarting.has(room.code) &&
          room.players.length >= room.expectedPlayers &&
          room.players.every((p) => p.connected)
        ) {
          autoStarting.add(room.code);
          try {
            await rooms.startGame(room.code, room.players[0].id);
            io.to(room.code).emit('game_started', { state: stateOf(room) });
            beginTurn(room); // arms the first roll clock + emits timer_started
          } catch (e) {
            // e.g. WALLET_REQUIRED / INSUFFICIENT_COINS / DB_REQUIRED for
            // entry-fee rooms — surface it so clients don't sit in limbo.
            io.to(room.code).emit('error', {
              code: (e as Error).message,
              message: (e as Error).message,
            });
          } finally {
            autoStarting.delete(room.code);
          }
        }
      } catch (e) {
        emitError(socket, (e as Error).message);
      }
    });

    socket.on('start_game', async (data: RoomRef) => {
      const room = getRoom(data?.code, socket);
      if (!room) return;
      try {
        await rooms.startGame(room.code, socket.id);
        io.to(room.code).emit('game_started', { state: stateOf(room) });
        beginTurn(room); // arms the first roll clock + emits timer_started
      } catch (e) {
        // startGame raises WALLET_REQUIRED / INSUFFICIENT_COINS / DB_REQUIRED
        // for entry-fee rooms; surface them as error events.
        emitError(socket, (e as Error).message);
      }
    });

    socket.on('roll_dice', (data: RoomRef) => {
      const room = getRoom(data?.code, socket);
      if (!room) return;
      if (!room.game || room.status === 'waiting') {
        return emitError(socket, 'GAME_NOT_STARTED', 'the game has not started yet');
      }
      const g = room.game;
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx === -1) return emitError(socket, 'NOT_IN_ROOM');
      if (g.winner !== null || room.status === 'finished') return emitError(socket, 'GAME_OVER');
      if (room.players[idx].eliminated) return emitError(socket, 'ELIMINATED', 'you are eliminated');
      if (idx !== g.currentPlayer) return emitError(socket, 'NOT_YOUR_TURN');
      if (g.lastRoll !== null) return emitError(socket, 'ALREADY_ROLLED');
      if (room.phase !== 'roll') return emitError(socket, 'NOT_ROLL_PHASE', 'not the roll phase');
      if (isLate(room)) {
        // Arrived past the grace period: the timeout path handles it.
        onTimeout(room, room.turnNonce);
        return;
      }
      disarmTimer(room);
      try {
        doRoll(room, idx, false);
      } catch (e) {
        emitError(socket, 'ROLL_FAILED', (e as Error).message);
        beginTurn(room); // re-arm so the game can't stall on a bad dice fn
        return;
      }
      if (g.lastRoll !== null) {
        armTimer(room, 'move'); // moves available -> move clock
      } else {
        beginTurn(room); // auto-passed (no life lost) -> next roll phase
      }
    });

    socket.on('move_token', (data: RoomRef) => {
      const room = getRoom(data?.code, socket);
      if (!room) return;
      if (!room.game || room.status === 'waiting') {
        return emitError(socket, 'GAME_NOT_STARTED', 'the game has not started yet');
      }
      const g = room.game;
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx === -1) return emitError(socket, 'NOT_IN_ROOM');
      if (g.winner !== null || room.status === 'finished') return emitError(socket, 'GAME_OVER');
      if (room.players[idx].eliminated) return emitError(socket, 'ELIMINATED', 'you are eliminated');
      if (idx !== g.currentPlayer) return emitError(socket, 'NOT_YOUR_TURN');
      if (g.lastRoll === null) return emitError(socket, 'NO_PENDING_ROLL');
      if (room.phase !== 'move') return emitError(socket, 'NOT_MOVE_PHASE', 'not the move phase');
      if (data?.tokenIndex === undefined) return emitError(socket, 'MISSING_TOKEN');
      if (isLate(room)) {
        onTimeout(room, room.turnNonce);
        return;
      }
      disarmTimer(room);
      let outcome: MoveOutcome;
      try {
        outcome = doMove(room, idx, data.tokenIndex, false);
      } catch (e) {
        emitError(socket, 'INVALID_MOVE', (e as Error).message);
        armTimer(room, 'move'); // re-arm so the game can't stall on a bad move
        return;
      }
      // doMove already finished the game on a win (finishGame disarmed).
      if (room.status !== 'playing') return;
      if (outcome.forfeited || !outcome.extraTurn) {
        beginTurn(room); // turn passed -> next roll phase
      } else {
        armTimer(room, 'roll'); // extra turn -> same player rolls again
      }
    });

    socket.on('leave_room', (data: RoomRef) => handleLeave(socket, data?.code));
    socket.on('disconnect', () => handleLeave(socket));
  });
}
