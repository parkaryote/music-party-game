import { PlaylistItem } from '../shared/types.js';

function parseVideoIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id || null;
    }

    if (url.hostname.includes('youtube.com')) {
      const watchId = url.searchParams.get('v');
      if (watchId) {
        return watchId;
      }

      const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) {
        return shortsMatch[1];
      }

      const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) {
        return embedMatch[1];
      }
    }
  } catch {
    return null;
  }

  return null;
}

function sanitizeVideoId(value: string): string | null {
  const trimmed = value.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export function parsePlaylistInput(input: string): PlaylistItem[] {
  const seen = new Set<string>();

  return input
    .split(/\r?\n|,/) 
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idFromUrl = parseVideoIdFromUrl(entry);
      const id = idFromUrl ?? sanitizeVideoId(entry);
      if (!id || seen.has(id)) {
        return null;
      }

      seen.add(id);
      return {
        videoId: id,
        title: id
      } satisfies PlaylistItem;
    })
    .filter((item): item is PlaylistItem => item !== null);
}
