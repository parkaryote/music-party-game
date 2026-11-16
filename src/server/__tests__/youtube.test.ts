import { describe, expect, it } from 'vitest';
import { hydrateTitles, parsePlaylistInput } from '../youtube.js';

describe('parsePlaylistInput', () => {
  it('reads URLs, short links, shorts and bare IDs', () => {
    const items = parsePlaylistInput(
      [
        'https://www.youtube.com/watch?v=fJ9rUzIMcZQ&t=10s',
        'https://youtu.be/kXYiU_JCYtU?si=abc',
        'youtube.com/shorts/aaaaaaaaaaa',
        'https://music.youtube.com/watch?v=bbbbbbbbbbb',
        'dQw4w9WgXcQ, ccccccccccc'
      ].join('\n')
    );
    expect(items.map((item) => item.videoId)).toEqual([
      'fJ9rUzIMcZQ',
      'kXYiU_JCYtU',
      'aaaaaaaaaaa',
      'bbbbbbbbbbb',
      'dQw4w9WgXcQ',
      'ccccccccccc'
    ]);
  });

  it('drops duplicates, junk and look-alike hosts', () => {
    const items = parsePlaylistInput(
      ['dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'not a video', 'https://notyoutube.com/watch?v=dddddddddddd', 'https://evil.example/youtu.be/eeeeeeeeeee'].join('\n')
    );
    expect(items.map((item) => item.videoId)).toEqual(['dQw4w9WgXcQ']);
  });

  it('reads a host-provided answer after "|", commas included', () => {
    const [item] = parsePlaylistInput('https://youtu.be/dQw4w9WgXcQ | Hello, Goodbye');
    expect(item.answerOverride).toBe('Hello, Goodbye');
  });

  it('caps the playlist length', () => {
    const many = Array.from({ length: 80 }, (_, i) => `vid${String(i).padStart(8, '0')}`).join('\n');
    expect(parsePlaylistInput(many)).toHaveLength(50);
  });
});

describe('hydrateTitles', () => {
  it('keeps order, fills titles and skips entries that cannot be answered', async () => {
    const playlist = parsePlaylistInput('aaaaaaaaaaa\nbbbbbbbbbbb\nccccccccccc | My Answer');
    const { items, skipped } = await hydrateTitles(playlist, async (videoId) =>
      videoId === 'aaaaaaaaaaa' ? { title: 'Artist - Song', author: 'Artist' } : null
    );
    expect(skipped).toBe(1);
    expect(items).toEqual([
      { videoId: 'aaaaaaaaaaa', title: 'Artist - Song', author: 'Artist' },
      { videoId: 'ccccccccccc', title: 'My Answer', answerOverride: 'My Answer' }
    ]);
  });
});
