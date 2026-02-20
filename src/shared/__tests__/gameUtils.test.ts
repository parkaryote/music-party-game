import { describe, expect, it } from 'vitest';
import { isGuessMatch, normalizeGuess } from '../gameUtils';

describe('normalizeGuess', () => {
  it('lowercases, removes punctuation and collapses spaces', () => {
    expect(normalizeGuess('  Hello,   WORLD!!! ')).toBe('hello world');
  });
});

describe('isGuessMatch', () => {
  it('matches inclusive substrings above minimum threshold', () => {
    expect(isGuessMatch('bohemian rhapsody live', 'Bohemian Rhapsody')).toBe(true);
    expect(isGuessMatch('Bohemian', 'bohemian rhapsody')).toBe(true);
  });

  it('rejects short guesses', () => {
    expect(isGuessMatch('ab', 'abcdef')).toBe(false);
  });

  it('rejects unrelated values', () => {
    expect(isGuessMatch('hotel california', 'smells like teen spirit')).toBe(false);
  });
});
