import { LIMITS, PlaylistItem } from '../shared/types.js';

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);

function parseVideoIdFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  let candidate: string | null | undefined;

  if (host === 'youtu.be') {
    candidate = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    candidate = url.searchParams.get('v');
    if (!candidate && ['shorts', 'embed', 'live', 'v'].includes(segments[0])) {
      candidate = segments[1];
    }
  }

  return candidate && VIDEO_ID.test(candidate) ? candidate : null;
}

function parseEntry(entry: string): PlaylistItem | null {
  // "URL | answer" lets the host set the accepted answer explicitly.
  const pipeIndex = entry.indexOf('|');
  const target = (pipeIndex >= 0 ? entry.slice(0, pipeIndex) : entry).trim();
  const answer = pipeIndex >= 0 ? entry.slice(pipeIndex + 1).trim().slice(0, 120) : '';

  const withScheme = /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(target) ? `https://${target}` : target;
  const videoId = parseVideoIdFromUrl(withScheme) ?? (VIDEO_ID.test(target) ? target : null);
  if (!videoId) return null;

  return { videoId, title: videoId, ...(answer ? { answerOverride: answer } : {}) };
}

/**
 * Accepts YouTube URLs or 11-character video IDs, one per line. Lines without an
 * explicit `| answer` may also hold several comma-separated entries.
 */
export function parsePlaylistInput(input: string): PlaylistItem[] {
  const seen = new Set<string>();
  const items: PlaylistItem[] = [];

  for (const line of input.slice(0, LIMITS.playlistInputLength).split(/\r?\n/)) {
    const entries = line.includes('|') ? [line] : line.split(',');
    for (const entry of entries) {
      const item = parseEntry(entry.trim());
      if (!item || seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      items.push(item);
      if (items.length >= LIMITS.playlistItems) return items;
    }
  }
  return items;
}

export type TitleFetcher = (videoId: string) => Promise<{ title: string; author?: string } | null>;

export const fetchTitleFromOEmbed: TitleFetcher = async (videoId) => {
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { title?: unknown; author_name?: unknown };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return null;
    return { title, author: typeof body.author_name === 'string' ? body.author_name : undefined };
  } catch {
    return null;
  }
};

/**
 * Looks up titles a few at a time. Entries whose title cannot be fetched are kept
 * only if the host supplied an answer; otherwise nobody could ever guess them.
 */
export async function hydrateTitles(
  playlist: PlaylistItem[],
  fetchTitle: TitleFetcher = fetchTitleFromOEmbed,
  concurrency = 5
): Promise<{ items: PlaylistItem[]; skipped: number }> {
  const results: Array<PlaylistItem | null> = new Array(playlist.length).fill(null);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < playlist.length) {
      const index = cursor;
      cursor += 1;
      const item = playlist[index];
      const fetched = await fetchTitle(item.videoId);
      if (fetched) {
        results[index] = { ...item, title: fetched.title, author: fetched.author };
      } else if (item.answerOverride) {
        results[index] = { ...item, title: item.answerOverride };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, playlist.length) }, worker));
  const items = results.filter((item): item is PlaylistItem => item !== null);
  return { items, skipped: playlist.length - items.length };
}
