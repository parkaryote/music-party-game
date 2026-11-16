import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  DEFAULT_SETTINGS,
  GuessFeedbackKind,
  GuessLogEntry,
  LIMITS,
  PlaylistPreview,
  PublicRoomState,
  SessionInfo
} from '../shared/types';
import { useSocket } from './hooks/useSocket';
import { YouTubePlayer } from './components/YouTubePlayer';
import './styles.css';

type Tone = 'neutral' | 'good' | 'bad';
interface Feedback {
  message: string;
  tone: Tone;
}

const SESSION_KEY = 'mpg_session';
const SOUND_KEY = 'mpg_sound';
const NICKNAME_KEY = 'mpg_nickname';

const GUESS_FEEDBACK: Record<GuessFeedbackKind, Feedback> = {
  correct: { message: '정답입니다!', tone: 'good' },
  wrong: { message: '오답입니다. 다시 도전해 보세요.', tone: 'bad' },
  too_fast: { message: '너무 빨라요. 잠시 후 다시 입력해 주세요.', tone: 'neutral' },
  closed: { message: '이번 라운드는 이미 끝났습니다.', tone: 'neutral' }
};

const PHASE_LABEL: Record<PublicRoomState['phase'], string> = {
  lobby: '대기실',
  playing: '게임 중',
  round_end: '정답 공개',
  finished: '게임 종료'
};

function readStored<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStored(storage: Storage, key: string, value: unknown): void {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode); the game still works without it.
  }
}

/** Re-renders a few times per second while a countdown is running. */
function useSecondsLeft(endsAt: number | undefined, clockOffset: number): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!endsAt) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [endsAt]);

  if (!endsAt) return null;
  return Math.max(0, Math.ceil((endsAt - (Date.now() + clockOffset)) / 1000));
}

function Landing({ socket, connected, onFeedback }: { socket: Socket; connected: boolean; onFeedback: (feedback: Feedback) => void }) {
  const [nickname, setNickname] = useState(() => readStored<string>(localStorage, NICKNAME_KEY) ?? '');
  const [roomCode, setRoomCode] = useState(() =>
    (new URLSearchParams(window.location.search).get('room') ?? '').toUpperCase().slice(0, 6)
  );

  const requireNickname = (): string | null => {
    const trimmed = nickname.trim();
    if (!trimmed) {
      onFeedback({ message: '닉네임을 입력해 주세요.', tone: 'bad' });
      return null;
    }
    writeStored(localStorage, NICKNAME_KEY, trimmed);
    return trimmed;
  };

  const createRoom = () => {
    const name = requireNickname();
    if (name) socket.emit('create_room', { nickname: name });
  };

  const joinRoom = () => {
    const name = requireNickname();
    if (!name) return;
    if (!roomCode.trim()) {
      onFeedback({ message: '참가할 방 코드를 입력해 주세요.', tone: 'bad' });
      return;
    }
    socket.emit('join_room', { code: roomCode.trim(), nickname: name });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (roomCode.trim()) joinRoom();
    else createRoom();
  };

  return (
    <form className="card landing" onSubmit={submit}>
      <h1>Music Party Game</h1>
      <p className="muted">유튜브 노래를 듣고 제목을 가장 먼저 맞히면 점수를 얻습니다.</p>

      <label htmlFor="nickname">닉네임</label>
      <input
        id="nickname"
        value={nickname}
        onChange={(event) => setNickname(event.target.value)}
        maxLength={LIMITS.nicknameLength}
        autoComplete="nickname"
        autoFocus
      />

      <label htmlFor="roomCode">방 코드 (참가할 때만)</label>
      <input
        id="roomCode"
        value={roomCode}
        onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
        maxLength={6}
        placeholder="예: K7PQ2M"
        autoComplete="off"
      />

      <div className="row">
        <button type="button" onClick={createRoom} disabled={!connected}>
          방 만들기
        </button>
        <button type="button" className="secondary" onClick={joinRoom} disabled={!connected}>
          참가하기
        </button>
      </div>
      {!connected && <p className="muted">서버에 연결하는 중…</p>}
    </form>
  );
}

function Scoreboard({ state, me }: { state: PublicRoomState; me: string }) {
  return (
    <div className="card">
      <h3>점수판</h3>
      <ol className="scoreboard">
        {state.players.map((player, index) => (
          <li key={player.nickname} className={player.connected ? '' : 'offline'}>
            <span className="rank">{index + 1}</span>
            <span className="name">
              {player.nickname}
              {player.nickname === state.hostNickname && <span className="badge">방장</span>}
              {player.nickname === me && <span className="badge me">나</span>}
              {!player.connected && <span className="badge off">재접속 대기</span>}
            </span>
            <span className="score">{player.score}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Lobby({
  socket,
  state,
  isHost,
  preview,
  onFeedback
}: {
  socket: Socket;
  state: PublicRoomState;
  isHost: boolean;
  preview: PlaylistPreview | null;
  onFeedback: (feedback: Feedback) => void;
}) {
  const [playlistInput, setPlaylistInput] = useState('');
  const [startSeconds, setStartSeconds] = useState(state.settings.startSeconds);
  const [roundSeconds, setRoundSeconds] = useState(state.settings.roundSeconds);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // The server answers a save with either a preview or an error.
    const onPreview = () => {
      setSaving(false);
      onFeedback({ message: '플레이리스트를 저장했습니다. 준비되면 게임을 시작하세요.', tone: 'good' });
    };
    const onError = () => setSaving(false);
    socket.on('playlist_preview', onPreview);
    socket.on('error_message', onError);
    return () => {
      socket.off('playlist_preview', onPreview);
      socket.off('error_message', onError);
    };
  }, [socket, onFeedback]);

  if (!isHost) {
    return (
      <div className="card">
        <h3>대기실</h3>
        <p>방장이 플레이리스트를 준비하고 있습니다.</p>
        <p className="muted">
          준비된 곡: {state.playlistCount}곡 · 라운드당 {state.settings.roundSeconds}초
        </p>
      </div>
    );
  }

  const savePlaylist = (event: FormEvent) => {
    event.preventDefault();
    if (!playlistInput.trim()) {
      onFeedback({ message: 'YouTube 주소를 한 줄에 하나씩 붙여 넣어 주세요.', tone: 'bad' });
      return;
    }
    setSaving(true);
    onFeedback({ message: '영상 제목을 불러오는 중…', tone: 'neutral' });
    socket.emit('set_playlist', { playlistInput, startSeconds, roundSeconds });
  };

  return (
    <div className="card">
      <h3>게임 설정</h3>
      <form onSubmit={savePlaylist}>
        <label htmlFor="playlist">플레이리스트</label>
        <textarea
          id="playlist"
          rows={7}
          value={playlistInput}
          onChange={(event) => setPlaylistInput(event.target.value)}
          placeholder={'https://www.youtube.com/watch?v=...\nhttps://youtu.be/... | 직접 정한 정답'}
        />
        <p className="muted small">
          YouTube 주소나 영상 ID를 한 줄에 하나씩 (최대 {LIMITS.playlistItems}곡). 정답은 영상 제목에서 자동으로 뽑고,
          <code> 주소 | 정답 </code> 형식으로 직접 정할 수도 있습니다.
        </p>
        <div className="row">
          <div>
            <label htmlFor="startSeconds">재생 시작 위치 (초)</label>
            <input
              id="startSeconds"
              type="number"
              min={0}
              max={LIMITS.startSecondsMax}
              value={startSeconds}
              onChange={(event) => setStartSeconds(Number(event.target.value) || 0)}
            />
          </div>
          <div>
            <label htmlFor="roundSeconds">라운드 제한 시간 (초)</label>
            <input
              id="roundSeconds"
              type="number"
              min={LIMITS.roundSecondsMin}
              max={LIMITS.roundSecondsMax}
              value={roundSeconds}
              onChange={(event) => setRoundSeconds(Number(event.target.value) || DEFAULT_SETTINGS.roundSeconds)}
            />
          </div>
        </div>
        <button type="submit" className="secondary" disabled={saving}>
          {saving ? '불러오는 중…' : '플레이리스트 저장'}
        </button>
      </form>

      {preview && preview.items.length > 0 && (
        <details className="preview" open>
          <summary>
            저장된 곡 {preview.items.length}곡{preview.skipped > 0 && ` (제목을 못 가져온 ${preview.skipped}곡 제외)`}
          </summary>
          <p className="muted small">방장에게만 보입니다. 인정되는 정답을 확인하세요.</p>
          <ol>
            {preview.items.map((item) => (
              <li key={item.videoId}>
                <span>{item.title}</span>
                <span className="answers">정답: {item.answers.join(' / ')}</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <button disabled={state.playlistCount === 0} onClick={() => socket.emit('start_game')}>
        게임 시작 ({state.playlistCount}곡)
      </button>
    </div>
  );
}

function App() {
  const { socket, connected } = useSocket();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [state, setState] = useState<PublicRoomState | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [preview, setPreview] = useState<PlaylistPreview | null>(null);
  const [log, setLog] = useState<GuessLogEntry[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [guess, setGuess] = useState('');
  const [playerError, setPlayerError] = useState(false);
  const [sound, setSound] = useState(() => readStored<{ muted: boolean; volume: number }>(sessionStorage, SOUND_KEY) ?? { muted: true, volume: 70 });
  const rejoining = useRef(false);
  const guessInput = useRef<HTMLInputElement | null>(null);

  const leaveLocally = useCallback(() => {
    writeStored(sessionStorage, SESSION_KEY, null);
    setSession(null);
    setState(null);
    setPreview(null);
    setLog([]);
  }, []);

  useEffect(() => {
    const onConnect = () => {
      // After a refresh or a dropped connection, take our seat back automatically.
      const saved = readStored<SessionInfo>(sessionStorage, SESSION_KEY);
      if (saved) {
        rejoining.current = true;
        socket.emit('join_room', saved);
      }
    };
    const onSession = (next: SessionInfo) => {
      rejoining.current = false;
      writeStored(sessionStorage, SESSION_KEY, next);
      setSession(next);
      setFeedback(null);
    };
    const onState = (next: PublicRoomState) => {
      setClockOffset(next.serverNow - Date.now());
      setState(next);
    };
    const onError = (message: string) => {
      if (rejoining.current) {
        // The saved room is gone; fall back to the start screen.
        rejoining.current = false;
        leaveLocally();
      }
      setFeedback({ message, tone: 'bad' });
    };
    const onKicked = (message: string) => {
      leaveLocally();
      setFeedback({ message, tone: 'bad' });
    };
    const onGuessFeedback = ({ kind }: { kind: GuessFeedbackKind }) => setFeedback(GUESS_FEEDBACK[kind] ?? null);
    const onGuessLog = (entry: GuessLogEntry) => setLog((entries) => [...entries.slice(-7), entry]);

    socket.on('connect', onConnect);
    socket.on('session', onSession);
    socket.on('state', onState);
    socket.on('error_message', onError);
    socket.on('kicked', onKicked);
    socket.on('guess_feedback', onGuessFeedback);
    socket.on('guess_log', onGuessLog);
    socket.on('playlist_preview', setPreview);
    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('session', onSession);
      socket.off('state', onState);
      socket.off('error_message', onError);
      socket.off('kicked', onKicked);
      socket.off('guess_feedback', onGuessFeedback);
      socket.off('guess_log', onGuessLog);
      socket.off('playlist_preview', setPreview);
    };
  }, [socket, leaveLocally]);

  useEffect(() => writeStored(sessionStorage, SOUND_KEY, sound), [sound]);

  const roundKey = state ? `${state.roundIndex}:${state.playback?.videoId ?? ''}` : '';
  useEffect(() => {
    // New round: clear the previous round's guesses and messages.
    setLog([]);
    setGuess('');
    setPlayerError(false);
    setFeedback(null);
  }, [roundKey]);

  useEffect(() => {
    if (state?.phase === 'playing') guessInput.current?.focus();
  }, [state?.phase, roundKey]);

  const rawSecondsLeft = useSecondsLeft(state?.phase === 'playing' ? state.roundEndsAt : undefined, clockOffset);
  // The short lead-in before playback starts should not show as extra time.
  const secondsLeft = rawSecondsLeft === null || !state ? null : Math.min(rawSecondsLeft, state.settings.roundSeconds);

  if (!state || !session) {
    return (
      <main className="layout narrow">
        <Landing socket={socket} connected={connected} onFeedback={setFeedback} />
        {feedback && <p className={`feedback ${feedback.tone}`} role="status">{feedback.message}</p>}
      </main>
    );
  }

  const isHost = state.hostNickname === session.nickname;
  const inGame = state.phase === 'playing' || state.phase === 'round_end';
  const winner = state.players[0];

  const submitGuess = (event: FormEvent) => {
    event.preventDefault();
    if (!guess.trim()) return;
    socket.emit('submit_guess', { guess });
    setGuess('');
  };

  const copyInvite = async () => {
    const link = `${window.location.origin}/?room=${state.code}`;
    try {
      await navigator.clipboard.writeText(link);
      setFeedback({ message: '초대 링크를 복사했습니다.', tone: 'good' });
    } catch {
      setFeedback({ message: `초대 링크: ${link}`, tone: 'neutral' });
    }
  };

  const leave = () => {
    socket.emit('leave_room');
    leaveLocally();
    setFeedback(null);
  };

  return (
    <main className="layout">
      <header className="card compact header">
        <div>
          <h2>
            방 코드 <span className="code">{state.code}</span>
          </h2>
          <p className="muted">
            {PHASE_LABEL[state.phase]} · 방장 {state.hostNickname}
            {isHost && ' (나)'}
            {!connected && ' · 재연결 중…'}
          </p>
        </div>
        <div className="row tight">
          <button type="button" className="secondary" onClick={copyInvite}>
            초대 링크 복사
          </button>
          <button type="button" className="ghost" onClick={leave}>
            나가기
          </button>
        </div>
      </header>

      <section className="grid">
        <div className="mainColumn">
          {state.phase === 'lobby' && (
            <Lobby socket={socket} state={state} isHost={isHost} preview={preview} onFeedback={setFeedback} />
          )}

          {inGame && (
            <div className="card">
              <div className="roundHeader">
                <h3>
                  라운드 {state.roundIndex + 1} / {state.totalRounds}
                </h3>
                {secondsLeft !== null && <span className={`timer ${secondsLeft <= 5 ? 'urgent' : ''}`}>{secondsLeft}초</span>}
              </div>

              {state.playback && (
                <YouTubePlayer
                  playback={state.playback}
                  clockOffset={clockOffset}
                  muted={sound.muted}
                  volume={sound.volume}
                  concealed={state.phase === 'playing'}
                  onError={() => setPlayerError(true)}
                />
              )}

              {playerError && (
                <p className="feedback bad">
                  이 영상은 재생할 수 없습니다 (삭제되었거나 외부 재생이 막힌 영상).
                  {isHost ? ' 아래 버튼으로 건너뛰세요.' : ' 방장이 건너뛸 때까지 기다려 주세요.'}
                </p>
              )}

              {sound.muted && (
                <button type="button" className="unmute" onClick={() => setSound((value) => ({ ...value, muted: false }))}>
                  🔊 소리 켜기 — 지금은 음소거 상태입니다
                </button>
              )}

              <div className="row controls">
                <label className="volume">
                  음량
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={sound.muted ? 0 : sound.volume}
                    onChange={(event) => {
                      const volume = Number(event.target.value);
                      setSound({ muted: volume === 0, volume: volume === 0 ? sound.volume : volume });
                    }}
                  />
                </label>
                {isHost && (
                  <>
                    <button type="button" className="secondary" onClick={() => socket.emit('resync')}>
                      재생 맞추기
                    </button>
                    <button type="button" className="secondary" onClick={() => socket.emit('skip_round')}>
                      {state.phase === 'playing' ? '이 곡 건너뛰기' : '다음 곡으로'}
                    </button>
                  </>
                )}
              </div>

              {state.phase === 'playing' ? (
                <form onSubmit={submitGuess}>
                  <input
                    ref={guessInput}
                    className="guessInput"
                    placeholder="노래 제목을 입력하고 Enter"
                    value={guess}
                    onChange={(event) => setGuess(event.target.value)}
                    maxLength={LIMITS.guessLength}
                    autoComplete="off"
                    aria-label="정답 입력"
                  />
                </form>
              ) : (
                <div className="reveal" role="status">
                  <p className="muted">정답</p>
                  <p className="revealTitle">{state.revealTitle}</p>
                  <p>
                    {state.roundWinnerNickname
                      ? `${state.roundWinnerNickname} 님이 맞혔습니다!`
                      : '아무도 맞히지 못했습니다.'}
                  </p>
                </div>
              )}

              {log.length > 0 && (
                <ul className="log" aria-label="최근 입력">
                  {log.map((entry, index) => (
                    <li key={index} className={entry.correct ? 'correct' : ''}>
                      <strong>{entry.nickname}</strong> {entry.correct ? '정답!' : entry.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {state.phase === 'finished' && (
            <div className="card finished">
              <h3>게임 종료</h3>
              {winner && winner.score > 0 ? (
                <p className="revealTitle">
                  🏆 {state.players.filter((player) => player.score === winner.score).map((player) => player.nickname).join(', ')} 우승!
                </p>
              ) : (
                <p>아무도 점수를 얻지 못했습니다.</p>
              )}
              {isHost ? (
                <button type="button" onClick={() => socket.emit('back_to_lobby')}>
                  대기실로 돌아가 다시 하기
                </button>
              ) : (
                <p className="muted">방장이 다음 게임을 준비할 때까지 기다려 주세요.</p>
              )}
            </div>
          )}

          {feedback && <p className={`feedback ${feedback.tone}`} role="status">{feedback.message}</p>}
        </div>

        <Scoreboard state={state} me={session.nickname} />
      </section>
    </main>
  );
}

export default App;
