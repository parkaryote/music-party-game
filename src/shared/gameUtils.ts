const punctuationRegex = /[^\p{L}\p{N}\s]/gu;

export function normalizeGuess(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(punctuationRegex, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGuessMatch(guessRaw: string, answerRaw: string, minLength = 4): boolean {
  const guess = normalizeGuess(guessRaw);
  const answer = normalizeGuess(answerRaw);

  if (!guess || !answer) {
    return false;
  }

  if (guess.length < minLength || answer.length < minLength) {
    return false;
  }

  return guess.includes(answer) || answer.includes(guess);
}
