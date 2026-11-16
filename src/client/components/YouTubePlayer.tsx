import { useEffect, useRef, useState } from 'react';
import type { PlaybackCommand } from '../../shared/types';

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YouTubePlayerProps {
  playback: PlaybackCommand;
  /** serverNow - Date.now(), so `roundStartAt` can be compared with the local clock. */
  clockOffset: number;
  muted: boolean;
  volume: number;
  /** Covers the video so its title cannot be read while guessing. */
  concealed: boolean;
  onError?: (code: number) => void;
}

let apiReadyPromise: Promise<void> | null = null;

function ensureApiReady(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();

  if (!apiReadyPromise) {
    apiReadyPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve();
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        apiReadyPromise = null;
        reject(new Error('YouTube player failed to load'));
      };
      document.head.appendChild(script);
    });
  }
  return apiReadyPromise;
}

export function YouTubePlayer({ playback, clockOffset, muted, volume, concealed, onError }: YouTubePlayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // Latest values for callbacks that must not re-trigger the playback effect.
  const latest = useRef({ muted, volume, clockOffset, onError });
  latest.current = { muted, volume, clockOffset, onError };

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    // YT.Player replaces its target with an iframe, so give it a node React does not manage.
    const target = document.createElement('div');
    host.appendChild(target);

    ensureApiReady()
      .then(() => {
        if (cancelled) return;
        playerRef.current = new window.YT.Player(target, {
          width: '100%',
          height: '100%',
          playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, iv_load_policy: 3 },
          events: {
            onReady: () => {
              if (!cancelled) setReady(true);
            },
            onError: (event: { data: number }) => latest.current.onError?.(event.data)
          }
        });
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });

    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy();
      } catch {
        // The iframe may already be gone.
      }
      playerRef.current = null;
      host.replaceChildren();
      setReady(false);
    };
  }, []);

  const { videoId, startSeconds, roundStartAt, syncId } = playback;

  useEffect(() => {
    const player = playerRef.current;
    if (!ready || !player) return;

    const applySound = () => {
      player.setVolume(latest.current.volume);
      if (latest.current.muted) player.mute();
      else player.unMute();
    };

    const delay = roundStartAt - (Date.now() + latest.current.clockOffset);
    if (delay <= 0) {
      // Joined late or re-syncing: jump to where everyone else already is.
      applySound();
      player.loadVideoById({ videoId, startSeconds: startSeconds - delay / 1000 });
      return;
    }

    applySound();
    player.cueVideoById({ videoId, startSeconds });
    const timer = window.setTimeout(() => {
      applySound();
      player.playVideo();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [ready, videoId, startSeconds, roundStartAt, syncId]);

  useEffect(() => {
    const player = playerRef.current;
    if (!ready || !player) return;
    player.setVolume(volume);
    if (muted) player.mute();
    else player.unMute();
  }, [ready, muted, volume]);

  return (
    <div className="player">
      <div ref={hostRef} className="playerFrame" />
      {concealed && (
        <div className="playerCover" aria-hidden="true">
          <span className="playerCoverIcon">♪</span>
          <span>{ready ? '재생 중 — 노래 제목을 맞혀 보세요' : '플레이어를 불러오는 중…'}</span>
        </div>
      )}
      {loadFailed && <p className="playerError">YouTube 플레이어를 불러오지 못했습니다. 네트워크나 광고 차단 설정을 확인해 주세요.</p>}
    </div>
  );
}
