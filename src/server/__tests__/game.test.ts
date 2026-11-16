import { createServer, Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaylistPreview, PublicRoomState, SessionInfo } from '../../shared/types.js';
import { attachGame, GameHandle } from '../game.js';

const TITLES: Record<string, { title: string; author: string }> = {
  aaaaaaaaaaa: { title: 'Queen - Bohemian Rhapsody (Official Video)', author: 'Queen Official' },
  bbbbbbbbbbb: { title: 'Oasis - Wonderwall', author: 'Oasis' }
};
const PLAYLIST = 'aaaaaaaaaaa\nbbbbbbbbbbb';

let httpServer: HttpServer;
let io: Server;
let game: GameHandle;
let url: string;
let clients: Socket[];

beforeEach(async () => {
  httpServer = createServer();
  io = new Server(httpServer);
  game = attachGame(io, {
    revealMs: 40,
    startDelayMs: 0,
    guessCooldownMs: 0,
    fetchTitle: async (videoId) => TITLES[videoId] ?? null
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  clients = [];
});

afterEach(async () => {
  clients.forEach((client) => client.disconnect());
  game.close();
  await io.close();
});

function client(): Socket {
  const socket = connect(url, { transports: ['websocket'], forceNew: true });
  clients.push(socket);
  return socket;
}

function once<T>(socket: Socket, event: string, predicate: (value: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 2000);
    const listener = (value: T) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(value);
    };
    socket.on(event, listener);
  });
}

const stateWhere = (socket: Socket, predicate: (state: PublicRoomState) => boolean) =>
  once<PublicRoomState>(socket, 'state', predicate);

async function createRoom(nickname = 'Host') {
  const host = client();
  const session = once<SessionInfo>(host, 'session');
  host.emit('create_room', { nickname });
  return { host, session: await session };
}

async function joinRoom(code: string, nickname: string, playerId?: string) {
  const socket = client();
  const session = once<SessionInfo>(socket, 'session');
  socket.emit('join_room', { code, nickname, playerId });
  return { socket, session: await session };
}

async function startGame(host: Socket, roundSeconds = 30) {
  const preview = once<PlaylistPreview>(host, 'playlist_preview');
  host.emit('set_playlist', { playlistInput: PLAYLIST, startSeconds: 12, roundSeconds });
  await preview;
  const playing = stateWhere(host, (state) => state.phase === 'playing');
  host.emit('start_game');
  return playing;
}

describe('game server', () => {
  it('creates a room, lets others join and rejects duplicate nicknames', async () => {
    const { host, session } = await createRoom('  Host  ');
    expect(session.nickname).toBe('Host');
    expect(session.code).toMatch(/^[A-Z2-9]{6}$/);

    const joined = stateWhere(host, (state) => state.players.length === 2);
    await joinRoom(session.code.toLowerCase(), 'Guest');
    expect((await joined).hostNickname).toBe('Host');

    const dup = client();
    const error = once<string>(dup, 'error_message');
    dup.emit('join_room', { code: session.code, nickname: 'guest' });
    expect(await error).toContain('닉네임');
  });

  it('survives malformed payloads', async () => {
    const socket = client();
    const error = once<string>(socket, 'error_message');
    socket.emit('create_room');
    socket.emit('join_room', { code: 42, nickname: null });
    socket.emit('submit_guess', 'nope');
    socket.emit('set_playlist', { playlistInput: {} });
    await error;
    const { session } = await createRoom();
    expect(session.code).toHaveLength(6);
  });

  it('only lets the host configure and start, and shows the host the accepted answers', async () => {
    const { host, session } = await createRoom();
    const { socket: guest } = await joinRoom(session.code, 'Guest');

    guest.emit('set_playlist', { playlistInput: PLAYLIST });
    guest.emit('start_game');

    const preview = once<PlaylistPreview>(host, 'playlist_preview');
    const saved = stateWhere(guest, (state) => state.playlistCount === 2);
    host.emit('set_playlist', { playlistInput: PLAYLIST, startSeconds: 9999, roundSeconds: 1 });
    expect((await preview).items[0].answers).toEqual(['Bohemian Rhapsody']);
    const state = await saved;
    expect(state.phase).toBe('lobby');
    expect(state.settings).toEqual({ startSeconds: 600, roundSeconds: 10 });
  });

  it('scores the first correct guess, hides the title until reveal, then advances and finishes', async () => {
    const { host, session } = await createRoom();
    const { socket: guest } = await joinRoom(session.code, 'Guest');

    const playing = await startGame(host);
    expect(playing.revealTitle).toBeUndefined();
    expect(playing.playback).toMatchObject({ videoId: 'aaaaaaaaaaa', startSeconds: 12 });
    expect(playing.roundEndsAt).toBeGreaterThan(playing.serverNow);

    const wrong = once<{ kind: string }>(guest, 'guess_feedback');
    guest.emit('submit_guess', { guess: 'queen' });
    expect((await wrong).kind).toBe('wrong');

    const reveal = stateWhere(host, (state) => state.phase === 'round_end');
    const log = once<{ nickname: string; text?: string; correct: boolean }>(host, 'guess_log', (entry) => entry.correct);
    guest.emit('submit_guess', { guess: 'bohemian rapsody' });
    expect(await log).toEqual({ nickname: 'Guest', correct: true });
    const revealed = await reveal;
    expect(revealed.roundWinnerNickname).toBe('Guest');
    expect(revealed.revealTitle).toContain('Bohemian Rhapsody');
    expect(revealed.players[0]).toMatchObject({ nickname: 'Guest', score: 1 });

    const second = await stateWhere(host, (state) => state.phase === 'playing' && state.roundIndex === 1);
    expect(second.playback?.videoId).toBe('bbbbbbbbbbb');

    const finished = stateWhere(host, (state) => state.phase === 'finished');
    host.emit('submit_guess', { guess: 'Wonderwall' });
    const final = await finished;
    expect(final.players.map((player) => player.score)).toEqual([1, 1]);

    const lobby = stateWhere(guest, (state) => state.phase === 'lobby');
    host.emit('back_to_lobby');
    expect((await lobby).playlistCount).toBe(2);
  });

  it('lets the host skip a round without awarding a point', async () => {
    const { host } = await createRoom();
    await startGame(host);
    const reveal = stateWhere(host, (state) => state.phase === 'round_end');
    host.emit('skip_round');
    const state = await reveal;
    expect(state.roundWinnerNickname).toBeUndefined();
    expect(state.revealTitle).toBeDefined();
  });

  it('keeps a seat and score across a reconnect and hands the host role over', async () => {
    const { host, session } = await createRoom();
    const { socket: guest, session: guestSession } = await joinRoom(session.code, 'Guest');
    await startGame(host);

    const reveal = stateWhere(host, (state) => state.phase === 'round_end');
    guest.emit('submit_guess', { guess: 'Bohemian Rhapsody' });
    await reveal;

    const dropped = stateWhere(host, (state) => state.players.some((player) => !player.connected));
    guest.disconnect();
    await dropped;

    const { socket: back, session: backSession } = await joinRoom(session.code, 'Whatever', guestSession.playerId);
    expect(backSession.nickname).toBe('Guest');

    const handedOver = stateWhere(back, (state) => state.hostNickname === 'Guest');
    host.disconnect();
    const state = await handedOver;
    expect(state.players.find((player) => player.nickname === 'Guest')).toMatchObject({ score: 1, connected: true });
  });

  it('removes a room once everyone has left', async () => {
    const { host } = await createRoom();
    expect(game.roomCount()).toBe(1);
    host.emit('leave_room');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(game.roomCount()).toBe(0);
  });
});
