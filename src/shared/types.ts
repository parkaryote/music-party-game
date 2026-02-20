export type Phase = 'landing' | 'lobby' | 'playing' | 'round_end' | 'finished';

export interface Player {
  socketId?: string;
  nickname: string;
  score: number;
  connected: boolean;
  lastSeenAt: number;
}

export interface PlaylistItem {
  videoId: string;
  title: string;
  answerOverride?: string;
}

export interface RoomSettings {
  startSeconds: number;
  roundDurationSeconds?: number;
}

export interface PlaybackCommand {
  videoId: string;
  startSeconds: number;
  roundStartAt: number;
}

export interface PublicRoomState {
  code: string;
  phase: Exclude<Phase, 'landing'>;
  hostNickname: string;
  players: Array<Pick<Player, 'nickname' | 'score' | 'connected'>>;
  playlistCount: number;
  roundIndex: number;
  totalRounds: number;
  roundWinnerNickname?: string;
  revealTitle?: string;
  settings: RoomSettings;
  playback?: PlaybackCommand;
}

export interface ClientSession {
  roomCode: string;
  nickname: string;
}
