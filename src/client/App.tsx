import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Socket } from 'socket.io-client';
import { PublicRoomState } from '../shared/types';
import { useSocket } from './hooks/useSocket';
import { YouTubePlayer } from './components/YouTubePlayer';
import './styles.css';

type FeedbackTone = 'neutral' | 'good' | 'bad';

function Landing({ socket, nickname, setNickname, roomCode, setRoomCode, setFeedback }: {
  socket: Socket;
  nickname: string;
  setNickname: (value: string) => void;
  roomCode: string;
  setRoomCode: (value: string) => void;
  setFeedback: (message: string, tone?: FeedbackTone) => void;
}) {
  const createRoom = () => {
    if (!nickname.trim()) {
      setFeedback('Please enter a nickname.', 'bad');
      return;
    }
    socket.emit('create_room', { nickname });
  };

  const joinRoom = () => {
    if (!nickname.trim() || !roomCode.trim()) {
      setFeedback('Nickname and room code are required to join.', 'bad');
      return;
    }
    socket.emit('join_room', { code: roomCode.trim().toUpperCase(), nickname });
  };

  return (
    <div className="card">
      <h1>Music Party Game</h1>
      <p>Guess the song title first to score points.</p>
      <label>Nickname</label>
      <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={24} />
      <label>Room code (for join)</label>
      <input value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} maxLength={6} />
      <div className="row">
        <button onClick={createRoom}>Create room</button>
        <button onClick={joinRoom}>Join room</button>
      </div>
    </div>
  );
}

function App() {
  const socket = useSocket();
  const [nickname, setNickname] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [playlistInput, setPlaylistInput] = useState('');
  const [startSeconds, setStartSeconds] = useState(30);
  const [guess, setGuess] = useState('');
  const [state, setState] = useState<PublicRoomState | null>(null);
  const [feedback, setFeedbackState] = useState<{ message: string; tone: FeedbackTone }>({ message: '', tone: 'neutral' });
  const [muted, setMuted] = useState(true);

  const setFeedback = (message: string, tone: FeedbackTone = 'neutral') => setFeedbackState({ message, tone });

  useEffect(() => {
    socket.on('state', (next: PublicRoomState) => {
      setState(next);
      setRoomCode(next.code);
    });
    socket.on('guess_feedback', (message: string) => {
      const tone: FeedbackTone = message.toLowerCase().includes('correct') ? 'good' : message.toLowerCase().includes('wrong') ? 'bad' : 'neutral';
      setFeedback(message, tone);
    });
    socket.on('error_message', (message: string) => setFeedback(message, 'bad'));

    return () => {
      socket.off('state');
      socket.off('guess_feedback');
      socket.off('error_message');
    };
  }, [socket]);

  const isHost = useMemo(() => state?.hostNickname === nickname, [state, nickname]);

  const submitPlaylist = (event: FormEvent) => {
    event.preventDefault();
    socket.emit('set_playlist', { playlistInput, startSeconds });
    setFeedback('Playlist saved. Start when ready.');
  };

  const submitGuess = (event: FormEvent) => {
    event.preventDefault();
    if (!guess.trim()) return;
    socket.emit('submit_guess', { guess });
    setGuess('');
  };

  if (!state) {
    return (
      <main className="layout">
        <Landing
          socket={socket}
          nickname={nickname}
          setNickname={setNickname}
          roomCode={roomCode}
          setRoomCode={setRoomCode}
          setFeedback={setFeedback}
        />
        {feedback.message && <p className={`feedback ${feedback.tone}`}>{feedback.message}</p>}
      </main>
    );
  }

  return (
    <main className="layout">
      <header className="card compact">
        <h2>Room {state.code}</h2>
        <p>Host: {state.hostNickname} {isHost ? '(you)' : ''}</p>
        <p>Phase: {state.phase}</p>
      </header>

      <section className="grid">
        <div className="card">
          <h3>Players</h3>
          <ul>
            {state.players.map((player) => (
              <li key={player.nickname}>
                {player.nickname} — {player.score} {player.connected ? '' : '(reconnecting...)'}
              </li>
            ))}
          </ul>
        </div>

        {state.phase === 'lobby' && (
          <div className="card">
            <h3>Lobby setup</h3>
            <p>Paste YouTube URLs or IDs separated by commas/new lines.</p>
            <form onSubmit={submitPlaylist}>
              <textarea rows={7} value={playlistInput} onChange={(e) => setPlaylistInput(e.target.value)} />
              <label>Start time (seconds)</label>
              <input type="number" min={0} max={240} value={startSeconds} onChange={(e) => setStartSeconds(Number(e.target.value) || 0)} />
              {isHost && <button type="submit">Save playlist</button>}
            </form>
            <p>Loaded tracks: {state.playlistCount}</p>
            {isHost && <button disabled={!state.playlistCount} onClick={() => socket.emit('start_game')}>Start game</button>}
          </div>
        )}

        {(state.phase === 'playing' || state.phase === 'round_end' || state.phase === 'finished') && (
          <div className="card">
            <h3>Round {Math.min(state.roundIndex + 1, state.totalRounds)} / {state.totalRounds}</h3>
            {state.playback && (
              <YouTubePlayer
                videoId={state.playback.videoId}
                startSeconds={state.playback.startSeconds}
                roundStartAt={state.playback.roundStartAt}
                muted={muted}
              />
            )}
            <div className="row">
              <button onClick={() => setMuted((v) => !v)}>{muted ? 'Unmute' : 'Mute'}</button>
              {isHost && <button onClick={() => socket.emit('resync')}>Resync playback</button>}
            </div>
            {state.phase !== 'finished' && (
              <form onSubmit={submitGuess}>
                <input
                  className="guessInput"
                  placeholder="Type song title guess and press Enter"
                  value={guess}
                  onChange={(e) => setGuess(e.target.value)}
                  disabled={state.phase === 'round_end'}
                />
              </form>
            )}
            {state.revealTitle && <p>Answer: <strong>{state.revealTitle}</strong></p>}
            {state.phase === 'finished' && isHost && <button onClick={() => socket.emit('next_round')}>Play again (advance)</button>}
          </div>
        )}
      </section>

      {feedback.message && <p className={`feedback ${feedback.tone}`}>{feedback.message}</p>}
    </main>
  );
}

export default App;
