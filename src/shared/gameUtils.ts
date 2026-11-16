const punctuationRegex = /[^\p{L}\p{N}\s]/gu;

/** Lowercases, unifies width/compatibility forms, and turns punctuation into spaces. */
export function normalizeGuess(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(punctuationRegex, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value: string): string {
  return normalizeGuess(value).replace(/\s/g, '');
}

// Phrases that describe the upload rather than the song; safe to drop anywhere.
const UPLOAD_PHRASE_PATTERN =
  /\b(official\s+(music\s+)?(video|audio|mv|m\/v|lyric\s+video|visualizer)|music\s+video|lyric\s+video|m\/v|mv)\b|뮤직\s*비디오|공식\s*(뮤직비디오|영상|음원)?/giu;

// Single words that are only noise inside brackets: "(Live)", "[Lyrics]", "(2011 Remaster)".
const BRACKET_NOISE_PATTERN =
  /\b(official|video|audio|lyrics?|visualizer|hd|hq|4k|remaster(ed)?|live|ver(sion)?|feat|ft|featuring|prod|cover|teaser|performance)\b|가사|자막|라이브|뮤직비디오|공식|커버|티저/iu;

const FEATURING_PATTERN = /\s+(feat\.?|ft\.?|featuring)\s.*$/iu;
const BRACKET_PATTERN = /[\(\[\{【「『（]([^\)\]\}】」』）]*)[\)\]\}】」』）]/gu;
const SEPARATOR_PATTERN = /\s+[-:~]\s+|\s*[–—|]\s*/u;
// "Title", “Title”, or 'Title' when the quotes are not apostrophes inside a word.
const QUOTED_PATTERN = /["“]([^"“”]{2,})["”]|(?<![\p{L}\p{N}])['‘]([^'‘’]{2,})['’](?![\p{L}\p{N}])/gu;

function cleanAuthor(author: string): string {
  return compact(
    author
      .replace(/\s*-\s*topic$/i, '')
      .replace(/vevo$/i, '')
      .replace(/\b(official|channel|music)\b/gi, ' ')
  );
}

function withoutBrackets(value: string): string {
  return value.replace(BRACKET_PATTERN, ' ');
}

/**
 * Derives the song-title answers from a YouTube video title such as
 * "Artist - Song (Official Video)" or "아이유(IU) - 좋은 날(Good Day) MV".
 *
 * The artist part is left out so that naming the artist does not win the round:
 * when a part matches the channel name it is treated as the artist, otherwise
 * the part before the first separator is.
 */
export function extractAnswers(title: string, author?: string): string[] {
  const answers: string[] = [];
  const add = (value: string) => {
    const cleaned = value
      .replace(UPLOAD_PHRASE_PATTERN, ' ')
      .replace(FEATURING_PATTERN, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (compact(cleaned).length === 0) return;
    if (!answers.some((existing) => compact(existing) === compact(cleaned))) {
      answers.push(cleaned);
    }
  };

  const parts = title
    .split(SEPARATOR_PATTERN)
    .map((part) => part.trim())
    .filter(Boolean);

  let titleParts = parts;
  if (parts.length > 1) {
    const authorKey = author ? cleanAuthor(author) : '';
    const isArtist = (part: string) => {
      const key = compact(withoutBrackets(part).replace(FEATURING_PATTERN, ''));
      return authorKey.length >= 2 && key.length >= 2 && (authorKey.includes(key) || key.includes(authorKey));
    };
    const withoutArtist = parts.filter((part) => !isArtist(part));
    titleParts = withoutArtist.length > 0 && withoutArtist.length < parts.length ? withoutArtist : parts.slice(1);
  }

  for (const part of titleParts) {
    const quoted = Array.from(part.matchAll(QUOTED_PATTERN), (match) => match[1] ?? match[2]);
    if (quoted.length > 0) {
      // IVE 'LOVE DIVE' MV: the quoted text is the title, the rest is the artist.
      quoted.forEach(add);
      continue;
    }
    add(withoutBrackets(part));
    // Bracketed text is often an alternative title: 좋은 날(Good Day).
    for (const bracket of part.matchAll(BRACKET_PATTERN)) {
      if (!BRACKET_NOISE_PATTERN.test(bracket[1])) add(bracket[1]);
    }
  }

  if (answers.length === 0) add(withoutBrackets(title));
  if (answers.length === 0) answers.push(title.trim());
  return answers;
}

export function editDistance(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  let previous = right.map((_, index) => index + 1);
  previous.unshift(0);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

function allowedTypos(length: number): number {
  if (length >= 10) return 2;
  if (length >= 5) return 1;
  return 0;
}

/**
 * A guess is correct when, ignoring case, spacing and punctuation, it
 *  - equals an answer,
 *  - is within a small typo distance of it, or
 *  - contains the whole answer plus a little extra (e.g. the artist name).
 *
 * Partial guesses ("love" for "Love Story") are intentionally not accepted.
 */
export function isGuessMatch(guessRaw: string, answers: string | string[]): boolean {
  const guess = compact(guessRaw);
  if (!guess) return false;

  const candidates = Array.isArray(answers) ? answers : [answers];
  return candidates.some((candidate) => {
    const answer = compact(candidate);
    if (!answer) return false;
    if (guess === answer) return true;

    const typos = allowedTypos(Array.from(answer).length);
    if (typos > 0 && Math.abs(guess.length - answer.length) <= typos && editDistance(guess, answer) <= typos) {
      return true;
    }

    // "queen bohemian rhapsody": answer must be a whole-word run and most of the guess.
    if (answer.length >= 3 && answer.length * 2 >= guess.length) {
      const guessWords = ` ${normalizeGuess(guessRaw)} `;
      const answerWords = ` ${normalizeGuess(candidate)} `;
      if (guessWords.includes(answerWords)) return true;
    }
    return false;
  });
}

/** Clamps untrusted numeric input into [min, max], falling back when it is not a number. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
