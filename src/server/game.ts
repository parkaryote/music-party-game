import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { clampInt, extractAnswers, isGuessMatch } from '../shared/gameUtils.js';
import {
  DEFAULT_SETTINGS,
  GuessFeedbackKind,
  GuessLogEntry,
  LIMITS,
  PlaybackCommand,
  PlaylistItem,
  PlaylistPreview,
  PublicRoomState,
  RoomPhase,
  RoomSettings,
  SessionInfo
} from '../shared/types.js';
import { fetchTitleFromOEmbed, hydrateTitles, parsePlaylistInput, TitleFetcher } from './youtube.js';

interface PlayerRecord {
  id: string;
  nickname: string;
  score: number;
  connected: boolean;
  socketId?: string;
  lastSeenAt: number;
  lastGuessAt: number;
}

interface Room {
  code: string;
  hostId: string;
  players: PlayerRecord[];
  playlist: PlaylistItem[];
  settings: RoomSettings;
  roundIndex: number;
  roundWinnerNickname?: string;
  phase: RoomPhase;
  playback?: PlaybackCommand;
  roundEndsAt?: number;
  timer?: NodeJS.Timeout;
  playlistRequest: number;
}

export interface GameOptions {
  /** How long the answer stays on screen before the next round. */
  revealMs?: number;
  /** Lead time so every client can load the video before playback starts. */
  startDelayMs?: number;
  guessCooldownMs?: number;
  /** How long a disconnected player's seat and score are kept. */
  playerReclaimMs?: number;
  cleanupIntervalMs?: number;
  fetchTitle?: TitleFetcher;
}

export interface GameHandle {
  roomCount(): number;
  close(): void;
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function asString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function sameNickname(a: string, b: string): boolean {
  return a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
}

function answersFor(item: PlaylistItem): string[] {
  return item.answerOverride ? [item.answerOverride] : extractAnswers(item.title, item.author);
}

export function attachGame(io: Server, options: GameOptions = {}): GameHandle {
  const revealMs = options.revealMs ?? 5000;
  const startDelayMs = options.startDelayMs ?? 1500;
  const guessCooldownMs = options.guessCooldownMs ?? 800;
  const playerReclaimMs = options.playerReclaimMs ?? 1000 * 60 * 2;
  const fetchTitle = options.fetchTitle ?? fetchTitleFromOEmbed;

  const rooms = new Map<string, Room>();
  /** socket id -> seat */
  const sessions = new Map<string, { roomCode: string; playerId: string }>();

  function genRoomCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 6; i += 1) {
        code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
      }
      if (!rooms.has(code)) return code;
    }
  }

  function toPublicState(room: Room): PublicRoomState {
    const current = room.playlist[room.roundIndex];
    const host = room.players.find((player) => player.id === room.hostId);

    return {
      code: room.code,
      phase: room.phase,
      hostNickname: host?.nickname ?? '',
      players: [...room.players]
        .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname))
        .map(({ nickname, score, connected }) => ({ nickname, score, connected })),
      playlistCount: room.playlist.length,
      roundIndex: room.roundIndex,
      totalRounds: room.playlist.length,
      roundWinnerNickname: room.roundWinnerNickname,
      revealTitle: room.phase === 'round_end' ? current?.title : undefined,
      settings: room.settings,
      playback: room.playback,
      roundEndsAt: room.roundEndsAt,
      serverNow: Date.now()
    };
  }

  function emitState(room: Room): void {
    io.to(room.code).emit('state', toPublicState(room));
  }

  function clearTimer(room: Room): void {
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = undefined;
    }
  }

  function deleteRoom(room: Room): void {
    clearTimer(room);
    rooms.delete(room.code);
  }

  function startRound(room: Room, index: number): void {
    clearTimer(room);
    const item = room.playlist[index];
    if (!item) {
      room.phase = 'finished';
      room.playback = undefined;
      room.roundEndsAt = undefined;
      room.roundWinnerNickname = undefined;
      emitState(room);
      return;
    }

    const roundStartAt = Date.now() + startDelayMs;
    room.roundIndex = index;
    room.roundWinnerNickname = undefined;
    room.phase = 'playing';
    room.playback = { videoId: item.videoId, startSeconds: room.settings.startSeconds, roundStartAt, syncId: 0 };
    room.roundEndsAt = roundStartAt + room.settings.roundSeconds * 1000;
    room.timer = setTimeout(() => endRound(room), room.roundEndsAt - Date.now());
    emitState(room);
  }

  /** Closes guessing, reveals the answer, then moves on after a short pause. */
  function endRound(room: Room, winner?: PlayerRecord): void {
    if (room.phase !== 'playing') return;
    clearTimer(room);
    room.phase = 'round_end';
    room.roundEndsAt = undefined;
    room.roundWinnerNickname = winner?.nickname;
    room.timer = setTimeout(() => startRound(room, room.roundIndex + 1), revealMs);
    emitState(room);
  }

  function ensureHost(room: Room): void {
    const host = room.players.find((player) => player.id === room.hostId);
    if (host?.connected) return;
    const next = room.players.find((player) => player.connected) ?? (host ? undefined : room.players[0]);
    if (next) room.hostId = next.id;
  }

  /** Detaches a socket from its seat. The seat stays reclaimable unless `remove` is set. */
  function detach(socketId: string, remove: boolean): void {
    const session = sessions.get(socketId);
    if (!session) return;
    sessions.delete(socketId);

    const room = rooms.get(session.roomCode);
    if (!room) return;
    const player = room.players.find((entry) => entry.id === session.playerId);
    if (!player || player.socketId !== socketId) return;

    if (remove) {
      room.players = room.players.filter((entry) => entry !== player);
    } else {
      player.connected = false;
      player.socketId = undefined;
      player.lastSeenAt = Date.now();
    }

    if (room.players.length === 0) {
      deleteRoom(room);
      return;
    }
    ensureHost(room);
    emitState(room);
  }

  function seat(socket: Socket, room: Room, player: PlayerRecord): void {
    player.socketId = socket.id;
    player.connected = true;
    player.lastSeenAt = Date.now();
    sessions.set(socket.id, { roomCode: room.code, playerId: player.id });
    socket.join(room.code);
    ensureHost(room);

    const session: SessionInfo = { code: room.code, nickname: player.nickname, playerId: player.id };
    socket.emit('session', session);
    emitState(room);
    if (player.id === room.hostId && room.playlist.length > 0) {
      socket.emit('playlist_preview', buildPreview(room.playlist, 0));
    }
  }

  function buildPreview(playlist: PlaylistItem[], skipped: number): PlaylistPreview {
    return {
      items: playlist.map((item) => ({ videoId: item.videoId, title: item.title, answers: answersFor(item) })),
      skipped
    };
  }

  function context(socket: Socket): { room: Room; player: PlayerRecord; isHost: boolean } | null {
    const session = sessions.get(socket.id);
    if (!session) return null;
    const room = rooms.get(session.roomCode);
    const player = room?.players.find((entry) => entry.id === session.playerId);
    if (!room || !player) return null;
    return { room, player, isHost: room.hostId === player.id };
  }

  function leaveCurrentRoom(socket: Socket): void {
    const session = sessions.get(socket.id);
    if (!session) return;
    socket.leave(session.roomCode);
    detach(socket.id, true);
  }

  io.on('connection', (socket) => {
    const fail = (message: string) => socket.emit('error_message', message);

    // Payloads come from untrusted clients; a malformed one must never take the server down.
    const on = (event: string, handler: (payload: Record<string, unknown>) => unknown) => {
      socket.on(event, async (payload: unknown) => {
        try {
          await handler(payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {});
        } catch (error) {
          console.error(`[${event}]`, error);
          fail('요청을 처리하지 못했습니다. 다시 시도해 주세요.');
        }
      });
    };

    on('create_room', (payload) => {
      const nickname = asString(payload.nickname, LIMITS.nicknameLength);
      if (!nickname) return fail('닉네임을 입력해 주세요.');

      leaveCurrentRoom(socket);
      const player: PlayerRecord = {
        id: randomUUID(),
        nickname,
        score: 0,
        connected: true,
        lastSeenAt: Date.now(),
        lastGuessAt: 0
      };
      const room: Room = {
        code: genRoomCode(),
        hostId: player.id,
        players: [player],
        playlist: [],
        settings: { ...DEFAULT_SETTINGS },
        roundIndex: 0,
        phase: 'lobby',
        playlistRequest: 0
      };
      rooms.set(room.code, room);
      seat(socket, room, player);
    });

    on('join_room', (payload) => {
      const code = asString(payload.code, 12).toUpperCase();
      const nickname = asString(payload.nickname, LIMITS.nicknameLength);
      const playerId = asString(payload.playerId, 64);
      const room = rooms.get(code);
      if (!room) return fail('방을 찾을 수 없습니다. 코드를 확인해 주세요.');

      const current = sessions.get(socket.id);
      if (current && current.roomCode !== room.code) leaveCurrentRoom(socket);

      // Returning player (refresh or dropped connection): give the seat back.
      let player = playerId ? room.players.find((entry) => entry.id === playerId) : undefined;
      if (!player) {
        if (!nickname) return fail('닉네임을 입력해 주세요.');
        const sameName = room.players.find((entry) => sameNickname(entry.nickname, nickname));
        if (sameName?.connected) return fail('이미 사용 중인 닉네임입니다.');
        player = sameName;
      }

      if (player) {
        if (player.socketId && player.socketId !== socket.id) {
          const previous = io.sockets.sockets.get(player.socketId);
          sessions.delete(player.socketId);
          previous?.leave(room.code);
          previous?.emit('kicked', '다른 창에서 접속해 이 창의 연결이 종료되었습니다.');
        }
        seat(socket, room, player);
        return;
      }

      if (room.players.length >= LIMITS.playersPerRoom) return fail('방이 가득 찼습니다.');
      const created: PlayerRecord = {
        id: randomUUID(),
        nickname,
        score: 0,
        connected: true,
        lastSeenAt: Date.now(),
        lastGuessAt: 0
      };
      room.players.push(created);
      seat(socket, room, created);
    });

    on('leave_room', () => {
      leaveCurrentRoom(socket);
    });

    on('set_playlist', async (payload) => {
      const ctx = context(socket);
      if (!ctx || !ctx.isHost || ctx.room.phase !== 'lobby') return;
      const { room } = ctx;

      const parsed = parsePlaylistInput(asString(payload.playlistInput, LIMITS.playlistInputLength));
      if (parsed.length === 0) return fail('올바른 YouTube 주소나 영상 ID를 찾지 못했습니다.');

      room.settings = {
        startSeconds: clampInt(payload.startSeconds, 0, LIMITS.startSecondsMax, DEFAULT_SETTINGS.startSeconds),
        roundSeconds: clampInt(
          payload.roundSeconds,
          LIMITS.roundSecondsMin,
          LIMITS.roundSecondsMax,
          DEFAULT_SETTINGS.roundSeconds
        )
      };

      // Title lookups are slow; if the host saves again meanwhile, only the latest result wins.
      room.playlistRequest += 1;
      const request = room.playlistRequest;
      const { items, skipped } = await hydrateTitles(parsed, fetchTitle);
      if (rooms.get(room.code) !== room || room.playlistRequest !== request || room.phase !== 'lobby') return;

      if (items.length === 0) {
        return fail('영상 제목을 가져오지 못했습니다. "주소 | 정답" 형식으로 정답을 직접 적어 주세요.');
      }
      room.playlist = items;
      emitState(room);
      socket.emit('playlist_preview', buildPreview(items, skipped));
    });

    on('start_game', () => {
      const ctx = context(socket);
      if (!ctx || !ctx.isHost || ctx.room.phase !== 'lobby') return;
      if (ctx.room.playlist.length === 0) return fail('먼저 플레이리스트를 저장해 주세요.');

      ctx.room.players.forEach((player) => {
        player.score = 0;
      });
      startRound(ctx.room, 0);
    });

    on('skip_round', () => {
      const ctx = context(socket);
      if (!ctx || !ctx.isHost) return;
      if (ctx.room.phase === 'playing') endRound(ctx.room);
      else if (ctx.room.phase === 'round_end') startRound(ctx.room, ctx.room.roundIndex + 1);
    });

    on('resync', () => {
      const ctx = context(socket);
      if (!ctx || !ctx.isHost || !ctx.room.playback) return;
      ctx.room.playback = { ...ctx.room.playback, syncId: ctx.room.playback.syncId + 1 };
      emitState(ctx.room);
    });

    on('back_to_lobby', () => {
      const ctx = context(socket);
      if (!ctx || !ctx.isHost) return;
      const { room } = ctx;
      clearTimer(room);
      room.phase = 'lobby';
      room.roundIndex = 0;
      room.roundWinnerNickname = undefined;
      room.playback = undefined;
      room.roundEndsAt = undefined;
      emitState(room);
    });

    on('submit_guess', (payload) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      const feedback = (kind: GuessFeedbackKind) => socket.emit('guess_feedback', { kind });

      const guess = asString(payload.guess, LIMITS.guessLength);
      if (!guess) return;
      if (room.phase !== 'playing') return feedback('closed');

      const now = Date.now();
      if (now - player.lastGuessAt < guessCooldownMs) return feedback('too_fast');
      player.lastGuessAt = now;

      const current = room.playlist[room.roundIndex];
      const correct = isGuessMatch(guess, answersFor(current));
      const entry: GuessLogEntry = correct
        ? { nickname: player.nickname, correct: true }
        : { nickname: player.nickname, text: guess, correct: false };
      io.to(room.code).emit('guess_log', entry);

      if (!correct) return feedback('wrong');
      player.score += 1;
      feedback('correct');
      endRound(room, player);
    });

    socket.on('disconnect', () => {
      detach(socket.id, false);
    });
  });

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const before = room.players.length;
      room.players = room.players.filter((player) => player.connected || now - player.lastSeenAt <= playerReclaimMs);

      // A room lives as long as someone is in it or can still come back.
      if (room.players.length === 0) {
        deleteRoom(room);
        continue;
      }
      if (room.players.length !== before) {
        ensureHost(room);
        emitState(room);
      }
    }
  }, options.cleanupIntervalMs ?? 30_000);
  cleanup.unref();

  return {
    roomCount: () => rooms.size,
    close: () => {
      clearInterval(cleanup);
      for (const room of rooms.values()) clearTimer(room);
      rooms.clear();
      sessions.clear();
    }
  };
}
