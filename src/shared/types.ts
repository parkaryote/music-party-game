export type RoomPhase = 'lobby' | 'playing' | 'round_end' | 'finished';

export interface PlaylistItem {
  videoId: string;
  /** Title as fetched from YouTube (shown at reveal). */
  title: string;
  /** Channel name from YouTube oEmbed; used to tell artist from song title. */
  author?: string;
  /** Host-provided answer (`URL | answer`). Replaces the auto-detected answers. */
  answerOverride?: string;
}

export interface RoomSettings {
  /** Where in the video each round starts playing. */
  startSeconds: number;
  /** How long players have to guess before the answer is revealed. */
  roundSeconds: number;
}

export interface PlaybackCommand {
  videoId: string;
  startSeconds: number;
  /** Server clock (ms) at which `startSeconds` should be playing. */
  roundStartAt: number;
  /** Bumped when the host asks everyone to re-seek to the shared position. */
  syncId: number;
}

export interface PublicPlayer {
  nickname: string;
  score: number;
  connected: boolean;
}

export interface PublicRoomState {
  code: string;
  phase: RoomPhase;
  hostNickname: string;
  players: PublicPlayer[];
  playlistCount: number;
  roundIndex: number;
  totalRounds: number;
  roundWinnerNickname?: string;
  /** Only present once the round is over. */
  revealTitle?: string;
  settings: RoomSettings;
  playback?: PlaybackCommand;
  /** Server clock (ms) when guessing closes for the current round. */
  roundEndsAt?: number;
  /** Server clock (ms) when this state was sent; lets clients correct clock skew. */
  serverNow: number;
}

/** Sent only to the socket that created/joined; `playerId` lets it reclaim its seat. */
export interface SessionInfo {
  code: string;
  nickname: string;
  playerId: string;
}

/** Sent only to the host after saving a playlist. */
export interface PlaylistPreview {
  items: Array<{ videoId: string; title: string; answers: string[] }>;
  /** Entries dropped because no title could be fetched and no answer was given. */
  skipped: number;
}

export type GuessFeedbackKind = 'correct' | 'wrong' | 'too_fast' | 'closed';

export interface GuessLogEntry {
  nickname: string;
  /** Omitted for correct guesses so the answer is not leaked early. */
  text?: string;
  correct: boolean;
}

export const LIMITS = {
  nicknameLength: 16,
  guessLength: 80,
  playlistItems: 50,
  playlistInputLength: 20_000,
  playersPerRoom: 30,
  startSecondsMax: 600,
  roundSecondsMin: 10,
  roundSecondsMax: 120
} as const;

export const DEFAULT_SETTINGS: RoomSettings = { startSeconds: 30, roundSeconds: 30 };
