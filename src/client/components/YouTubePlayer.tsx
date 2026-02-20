import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YouTubePlayerProps {
  videoId?: string;
  startSeconds: number;
  roundStartAt?: number;
  muted: boolean;
}

let apiReadyPromise: Promise<void> | null = null;

function ensureApiReady(): Promise<void> {
  if (window.YT?.Player) {
    return Promise.resolve();
  }

  if (!apiReadyPromise) {
    apiReadyPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      window.onYouTubeIframeAPIReady = () => resolve();
      document.body.appendChild(script);
    });
  }

  return apiReadyPromise;
}

export function YouTubePlayer({ videoId, startSeconds, roundStartAt, muted }: YouTubePlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);

  useEffect(() => {
    let mounted = true;

    ensureApiReady().then(() => {
      if (!mounted || !containerRef.current || playerRef.current) {
        return;
      }

      playerRef.current = new window.YT.Player(containerRef.current, {
        width: '100%',
        height: '360',
        playerVars: {
          controls: 1,
          rel: 0,
          modestbranding: 1
        }
      });
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !videoId) return;

    const delay = Math.max(0, (roundStartAt ?? Date.now()) - Date.now());
    const timer = window.setTimeout(() => {
      player.loadVideoById({ videoId, startSeconds });
      if (muted) {
        player.mute();
      } else {
        player.unMute();
      }
      player.playVideo();
    }, delay);

    return () => window.clearTimeout(timer);
  }, [videoId, startSeconds, roundStartAt]);

  useEffect(() => {
    if (!playerRef.current) return;
    if (muted) {
      playerRef.current.mute();
    } else {
      playerRef.current.unMute();
    }
  }, [muted]);

  return <div ref={containerRef} />;
}
