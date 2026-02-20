import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { isGuessMatch } from '../shared/gameUtils.js';
import { parsePlaylistInput } from './youtube.js';
import { PlaybackCommand, Player, PlaylistItem, PublicRoomState, RoomSettings } from '../shared/types.js';

interface Room {
  code: string;
  hostSocketId: string;
  players: Player[];
  playlist: PlaylistItem[];
  settings: RoomSettings;
  roundIndex: number;
  roundWinnerNickname?: string;
  phase: 'lobby' | 'playing' | 'round_end' | 'finished';
  lastActiveAt: number;
  playback?: PlaybackCommand;
  roundEndTimer?: NodeJS.Timeout;
}

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const rooms = new Map<string, Room>();
const socketSession = new Map<string, { roomCode: string; nickname: string }>();
const guessCooldown = new Map<string, number>();
const ROOM_INACTIVE_TTL = 1000 * 60 * 20;
const PLAYER_RECLAIM_TTL = 1000 * 60 * 2;
const ROUND_REVEAL_MS = 3500;

function genRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(result) ? genRoomCode() : result;
}

function getHostNickname(room: Room): string {
  const host = room.players.find((p) => p.socketId === room.hostSocketId);
  return host?.nickname ?? 'Unknown';
}

function toPublicState(room: Room): PublicRoomState {
  const current = room.playlist[room.roundIndex];

  return {
    code: room.code,
    phase: room.phase,
    hostNickname: getHostNickname(room),
    players: [...room.players]
      .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname))
      .map((player) => ({ nickname: player.nickname, score: player.score, connected: player.connected })),
    playlistCount: room.playlist.length,
    roundIndex: room.roundIndex,
    totalRounds: room.playlist.length,
    roundWinnerNickname: room.roundWinnerNickname,
    revealTitle: room.phase === 'round_end' || room.phase === 'finished' ? current?.title : undefined,
    settings: room.settings,
    playback: room.playback
  };
}

function emitState(roomCode: string): void {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.lastActiveAt = Date.now();
  io.to(roomCode).emit('state', toPublicState(room));
}

function findOrCreatePlayer(room: Room, nickname: string, socketId: string): Player {
  const now = Date.now();
  const existing = room.players.find((player) => player.nickname === nickname);

  if (existing) {
    if (!existing.connected && now - existing.lastSeenAt <= PLAYER_RECLAIM_TTL) {
      existing.socketId = socketId;
      existing.connected = true;
      existing.lastSeenAt = now;
      return existing;
    }

    if (existing.connected) {
      throw new Error('Nickname is already in use in this room.');
    }

    throw new Error('Nickname reclaim window expired. Please choose another nickname.');
  }

  const player: Player = {
    socketId,
    nickname,
    score: 0,
    connected: true,
    lastSeenAt: now
  };

  room.players.push(player);
  return player;
}

function moveToNextRound(room: Room): void {
  if (room.roundEndTimer) {
    clearTimeout(room.roundEndTimer);
    room.roundEndTimer = undefined;
  }

  room.roundIndex += 1;
  room.roundWinnerNickname = undefined;

  if (room.roundIndex >= room.playlist.length) {
    room.phase = 'finished';
    room.playback = undefined;
    emitState(room.code);
    return;
  }

  room.phase = 'playing';
  const next = room.playlist[room.roundIndex];
  room.playback = {
    videoId: next.videoId,
    startSeconds: room.settings.startSeconds,
    roundStartAt: Date.now() + 600
  };
  emitState(room.code);
}

async function hydrateTitles(playlist: PlaylistItem[]): Promise<PlaylistItem[]> {
  const hydrated = await Promise.all(
    playlist.map(async (item) => {
      try {
        const target = `https://www.youtube.com/watch?v=${item.videoId}`;
        const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`);
        if (!response.ok) {
          return item;
        }
        const body = (await response.json()) as { title?: string };
        return { ...item, title: body.title?.trim() || item.title };
      } catch {
        return item;
      }
    })
  );

  return hydrated;
}

io.on('connection', (socket) => {
  socket.on('create_room', async ({ nickname }: { nickname: string }) => {
    const trimmed = nickname.trim();
    if (!trimmed) {
      socket.emit('error_message', 'Nickname is required.');
      return;
    }

    const code = genRoomCode();
    const room: Room = {
      code,
      hostSocketId: socket.id,
      players: [],
      playlist: [],
      settings: { startSeconds: 30 },
      roundIndex: 0,
      phase: 'lobby',
      lastActiveAt: Date.now()
    };

    findOrCreatePlayer(room, trimmed, socket.id);
    rooms.set(code, room);
    socketSession.set(socket.id, { roomCode: code, nickname: trimmed });
    socket.join(code);
    emitState(code);
  });

  socket.on('join_room', ({ code, nickname }: { code: string; nickname: string }) => {
    const room = rooms.get(code.toUpperCase());
    const trimmed = nickname.trim();
    if (!room) {
      socket.emit('error_message', 'Room not found.');
      return;
    }
    if (!trimmed) {
      socket.emit('error_message', 'Nickname is required.');
      return;
    }

    try {
      findOrCreatePlayer(room, trimmed, socket.id);
      socketSession.set(socket.id, { roomCode: room.code, nickname: trimmed });
      socket.join(room.code);
      emitState(room.code);
    } catch (error) {
      socket.emit('error_message', (error as Error).message);
    }
  });

  socket.on('set_playlist', async ({ playlistInput, startSeconds }: { playlistInput: string; startSeconds: number }) => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    const room = rooms.get(session.roomCode);
    if (!room || room.hostSocketId !== socket.id || room.phase !== 'lobby') return;

    const parsed = parsePlaylistInput(playlistInput);
    if (!parsed.length) {
      socket.emit('error_message', 'No valid YouTube URLs/IDs found.');
      return;
    }

    room.playlist = await hydrateTitles(parsed);
    room.settings.startSeconds = Math.max(0, Math.min(240, Math.floor(startSeconds || 30)));
    emitState(room.code);
  });

  socket.on('start_game', () => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    const room = rooms.get(session.roomCode);
    if (!room || room.hostSocketId !== socket.id || room.phase !== 'lobby' || !room.playlist.length) return;

    room.players.forEach((player) => {
      player.score = 0;
    });

    room.roundIndex = 0;
    room.roundWinnerNickname = undefined;
    room.phase = 'playing';
    room.playback = {
      videoId: room.playlist[0].videoId,
      startSeconds: room.settings.startSeconds,
      roundStartAt: Date.now() + 600
    };
    emitState(room.code);
  });

  socket.on('resync', () => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    const room = rooms.get(session.roomCode);
    if (!room || room.hostSocketId !== socket.id || !room.playback) return;

    room.playback = {
      ...room.playback,
      roundStartAt: Date.now() + 400
    };
    emitState(room.code);
  });

  socket.on('next_round', () => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    const room = rooms.get(session.roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    moveToNextRound(room);
  });

  socket.on('submit_guess', ({ guess }: { guess: string }) => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    const room = rooms.get(session.roomCode);
    if (!room || room.phase !== 'playing') return;

    const player = room.players.find((entry) => entry.socketId === socket.id);
    if (!player) return;

    const now = Date.now();
    const cooldownKey = `${room.code}:${player.nickname}`;
    const lastGuessAt = guessCooldown.get(cooldownKey) ?? 0;
    if (now - lastGuessAt < 800) {
      socket.emit('guess_feedback', 'Too fast: wait 800ms between guesses.');
      return;
    }
    guessCooldown.set(cooldownKey, now);

    if (room.roundWinnerNickname) {
      socket.emit('guess_feedback', 'Already answered for this round.');
      return;
    }

    const current = room.playlist[room.roundIndex];
    const answer = current.answerOverride ?? current.title;
    const matched = isGuessMatch(guess, answer, 4);
    if (!matched) {
      socket.emit('guess_feedback', 'Wrong');
      return;
    }

    room.roundWinnerNickname = player.nickname;
    player.score += 1;
    room.phase = 'round_end';
    socket.emit('guess_feedback', 'Correct');
    socket.to(room.code).emit('guess_feedback', `${player.nickname} was first!`);
    emitState(room.code);

    room.roundEndTimer = setTimeout(() => {
      moveToNextRound(room);
    }, ROUND_REVEAL_MS);
  });

  socket.on('disconnect', () => {
    const session = socketSession.get(socket.id);
    if (!session) {
      return;
    }

    const room = rooms.get(session.roomCode);
    if (!room) {
      socketSession.delete(socket.id);
      return;
    }

    const player = room.players.find((entry) => entry.nickname === session.nickname);
    if (player) {
      player.connected = false;
      player.socketId = undefined;
      player.lastSeenAt = Date.now();
    }

    if (room.hostSocketId === socket.id) {
      const nextHost = room.players.find((entry) => entry.connected && entry.socketId);
      if (nextHost?.socketId) {
        room.hostSocketId = nextHost.socketId;
      }
    }

    socketSession.delete(socket.id);
    emitState(room.code);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    room.players = room.players.filter((player) => player.connected || now - player.lastSeenAt <= PLAYER_RECLAIM_TTL);
    if (now - room.lastActiveAt > ROOM_INACTIVE_TTL) {
      if (room.roundEndTimer) {
        clearTimeout(room.roundEndTimer);
      }
      rooms.delete(code);
    }
  }
}, 30_000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, '../client');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const port = Number(process.env.PORT || 3000);
httpServer.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
