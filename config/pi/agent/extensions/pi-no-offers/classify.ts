export type Verdict =
  | { nudge: true; closer: string }
  | { nudge: false; reason: "no-closer" | "irreversible" | "question-turn" | "already-nudged" };

const TAIL_LENGTH = 600;
const SENTENCE_BOUNDARY_RE = /[.!?\n]+/g;

const CLOSER_PHRASES = [
  "say the word",
  "want me to",
  "would you like me to",
  "should i",
  "shall i",
  "offer stands",
  "may i",
  "do you want me to",
  "let me know if you'd like",
  "let me know if you would like",
  "if you want, i can",
  "if you want i can",
];

const REGEX_SPECIALS_RE = /[.*+?^${}()|[\]\\]/g;
const CLOSER_RE = new RegExp(
  `\\b(?:${CLOSER_PHRASES.map((phrase) => phrase.replace(REGEX_SPECIALS_RE, "\\$&")).join("|")})\\b`,
  "i",
);
const HAPPY_TO_RE = /\bhappy to\b(?=[^.!?\n]*\bif you\b)/i;

const QUESTION_PREFIXES = [
  "explain",
  "why",
  "how",
  "what",
  "which",
  "where",
  "when",
  "is",
  "are",
  "does",
  "do",
  "can",
  "could",
  "should",
  "would",
];
const QUESTION_RE = new RegExp(`^(?:${QUESTION_PREFIXES.join("|")})\\b`, "i");
const NO_CHANGES_RE = /no changes yet/i;

const IRREVERSIBLE_RE =
  /\b(?:merge[sd]?|merging|force[- ]push(?:es|ed|ing)?|deploy(?:s|ed|ing)?|delete[sd]?|deleting|drop(?:s|ped|ping)?|rm\s+-rf|prod|production|customer|payment|billing|revert(?:s|ed|ing)?|reset\s+--hard)\b/i;

type CloserMatch = { closer: string; index: number };

function tailOf(text: string): string {
  return text.slice(-TAIL_LENGTH);
}

function sentenceContaining(text: string, index: number): string {
  const boundaries = [...text.matchAll(SENTENCE_BOUNDARY_RE)].map((match) => match.index ?? 0);
  const start = boundaries.reduce(
    (cursor, boundary) => (boundary < index ? boundary + 1 : cursor),
    0,
  );
  const end = boundaries.find((boundary) => boundary >= index) ?? text.length;
  return text.slice(start, end);
}

function findCloserMatch(text: string): CloserMatch | null {
  const tail = tailOf(text);
  const matches: CloserMatch[] = [];
  const plain = CLOSER_RE.exec(tail);
  const happy = HAPPY_TO_RE.exec(tail);
  if (plain !== null) matches.push({ closer: plain[0], index: plain.index });
  if (happy !== null) matches.push({ closer: happy[0], index: happy.index });
  return matches.reduce<CloserMatch | null>(
    (first, match) => (first === null || match.index < first.index ? match : first),
    null,
  );
}

export function findCloser(text: string): string | null {
  return findCloserMatch(text)?.closer ?? null;
}

export function isIrreversible(sentence: string): boolean {
  return IRREVERSIBLE_RE.test(sentence);
}

export function isQuestionTurn(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed.endsWith("?") || QUESTION_RE.test(trimmed) || NO_CHANGES_RE.test(trimmed);
}

export function classify(input: {
  assistantText: string;
  userPrompt: string;
  nudgedThisTurn: boolean;
}): Verdict {
  if (input.nudgedThisTurn) return { nudge: false, reason: "already-nudged" };
  if (isQuestionTurn(input.userPrompt)) return { nudge: false, reason: "question-turn" };
  const match = findCloserMatch(input.assistantText);
  if (match === null) return { nudge: false, reason: "no-closer" };
  if (isIrreversible(sentenceContaining(tailOf(input.assistantText), match.index))) {
    return { nudge: false, reason: "irreversible" };
  }
  return { nudge: true, closer: match.closer };
}
