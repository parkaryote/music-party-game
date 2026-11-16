import { describe, expect, it } from 'vitest';
import { clampInt, editDistance, extractAnswers, isGuessMatch, normalizeGuess } from '../gameUtils.js';

describe('normalizeGuess', () => {
  it('lowercases, removes punctuation and collapses spaces', () => {
    expect(normalizeGuess('  Hello,   WORLD!!! ')).toBe('hello world');
  });

  it('keeps Hangul syllables intact and unifies full-width characters', () => {
    expect(normalizeGuess('좋은  날!')).toBe('좋은 날');
    expect(normalizeGuess('ＬＯＶＥ')).toBe('love');
  });
});

describe('extractAnswers', () => {
  it('drops the artist and upload noise from "Artist - Title (Official Video)"', () => {
    expect(extractAnswers('Queen – Bohemian Rhapsody (Official Video Remastered)')).toEqual(['Bohemian Rhapsody']);
    expect(extractAnswers('Rick Astley - Never Gonna Give You Up (Official Music Video)')).toEqual([
      'Never Gonna Give You Up'
    ]);
  });

  it('uses the channel name to find the artist when the title comes first', () => {
    expect(extractAnswers('Shape of You - Ed Sheeran', 'Ed Sheeran')).toEqual(['Shape of You']);
    expect(extractAnswers('Ed Sheeran - Shape of You [Official Video]', 'Ed Sheeran')).toEqual(['Shape of You']);
  });

  it('keeps bracketed alternative titles but not bracketed noise', () => {
    expect(extractAnswers('아이유(IU) - 좋은 날(Good Day) MV')).toEqual(['좋은 날', 'Good Day']);
    expect(extractAnswers('Oasis - Wonderwall (Live at Wembley)')).toEqual(['Wonderwall']);
  });

  it('prefers a quoted title', () => {
    expect(extractAnswers("IVE 아이브 'LOVE DIVE' MV")).toEqual(['LOVE DIVE']);
    expect(extractAnswers("Journey - Don't Stop Believin' (Official Audio)")).toEqual(["Don't Stop Believin'"]);
  });

  it('handles featuring credits and titles without a separator', () => {
    expect(extractAnswers('Artist feat. Someone - Stay With Me')).toEqual(['Stay With Me']);
    expect(extractAnswers('Song Name (feat. Guest)')).toEqual(['Song Name']);
    expect(extractAnswers('Live Forever')).toEqual(['Live Forever']);
  });

  it('never returns an empty list', () => {
    expect(extractAnswers('(Official Video)').length).toBeGreaterThan(0);
  });
});

describe('isGuessMatch', () => {
  it('accepts exact answers ignoring case, spacing and punctuation', () => {
    expect(isGuessMatch('bohemian rhapsody', 'Bohemian Rhapsody')).toBe(true);
    expect(isGuessMatch('좋은날', ['좋은 날', 'Good Day'])).toBe(true);
    expect(isGuessMatch('good day!', ['좋은 날', 'Good Day'])).toBe(true);
  });

  it('tolerates small typos on longer answers only', () => {
    expect(isGuessMatch('bohemian rapsody', 'Bohemian Rhapsody')).toBe(true);
    expect(isGuessMatch('wonderwal', 'Wonderwall')).toBe(true);
    expect(isGuessMatch('lave', 'Love')).toBe(false);
  });

  it('accepts the answer with a little extra such as the artist', () => {
    expect(isGuessMatch('queen bohemian rhapsody', 'Bohemian Rhapsody')).toBe(true);
  });

  it('rejects partial, padded and unrelated guesses', () => {
    expect(isGuessMatch('love', 'Love Story')).toBe(false);
    expect(isGuessMatch('official', 'Bohemian Rhapsody')).toBe(false);
    expect(isGuessMatch('love hello yesterday imagine believer thriller', 'Hello')).toBe(false);
    expect(isGuessMatch('hotel california', 'smells like teen spirit')).toBe(false);
    expect(isGuessMatch('   ', 'anything')).toBe(false);
  });
});

describe('helpers', () => {
  it('computes edit distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('clamps untrusted numbers', () => {
    expect(clampInt('45', 0, 100, 30)).toBe(45);
    expect(clampInt(999, 0, 100, 30)).toBe(100);
    expect(clampInt('abc', 0, 100, 30)).toBe(30);
    expect(clampInt(undefined, 0, 100, 30)).toBe(30);
  });
});
