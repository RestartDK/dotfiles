import { describe, expect, test } from "bun:test";
import { classify, findCloser, isIrreversible, isQuestionTurn } from "./classify.ts";

function verdictFor(assistantText: string, userPrompt = "carry on") {
  return classify({ assistantText, userPrompt, warnedThisTurn: false });
}

describe("trailing offer warnings", () => {
  const phrases = [
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
  for (const phrase of phrases) {
    test(phrase, () => {
      expect(verdictFor(`${phrase} finish the focused test.`)).toEqual({
        kind: "warning",
        closer: phrase,
      });
    });
  }
  test("happy to with a condition", () => {
    expect(verdictFor("Happy to finish the refactor if you want.")).toEqual({
      kind: "warning",
      closer: "Happy to",
    });
  });
  test("capitalization and punctuation", () => {
    expect(findCloser("SAY THE WORD!!!")).toBe("SAY THE WORD");
    expect(findCloser("should i...")).toBe("should i");
    expect(findCloser("SHALL I GO AHEAD?!")).toBe("SHALL I");
    expect(verdictFor("Done. Want me to take it from here...")).toEqual({
      kind: "warning",
      closer: "Want me to",
    });
  });
});

test("a closer outside the tail does not warn about completed work", () => {
  const text = `Say the word.${"x".repeat(2000)}`;
  expect(findCloser(text)).toBeNull();
  expect(verdictFor(text)).toEqual({ kind: "skip", reason: "no-closer" });
});

test("a plain completion summary is not a continuation request", () => {
  expect(verdictFor("Done. The diff is above.")).toEqual({ kind: "skip", reason: "no-closer" });
});

describe("permission boundaries", () => {
  const sentences = [
    "Say the word and I merge",
    "Should I force-push the branch?",
    "Want me to deploy it?",
    "Want me to delete that file?",
    "Want me to drop the table?",
    "Want me to run rm -rf /tmp?",
    "Want me to reset --hard?",
    "Want me to change customer data?",
    "Want me to change the payment?",
    "Want me to update billing?",
    "Want me to change production?",
    "Want me to change prod?",
    "Want me to revert the change?",
    "Want me to commit this?",
    "Want me to push this?",
    "Want me to open a PR?",
    "Want me to open a dotfiles pull request?",
  ];
  for (const sentence of sentences) {
    test(sentence, () => {
      expect(isIrreversible(sentence)).toBe(true);
      expect(verdictFor(sentence)).toEqual({ kind: "skip", reason: "irreversible" });
    });
  }
  test("running a local test remains reversible", () => {
    expect(isIrreversible("I will run the tests")).toBe(false);
  });
});

describe("question turns are analysis only", () => {
  for (const prompt of [
    "explain this",
    "why does x?",
    "how does it work",
    "is it green?",
    "no changes yet, just look",
    "This ends with a question?",
  ]) {
    test(prompt, () => {
      expect(isQuestionTurn(prompt)).toBe(true);
      expect(verdictFor("Want me to continue?", prompt)).toEqual({
        kind: "skip",
        reason: "question-turn",
      });
    });
  }
  for (const prompt of [
    "do this now then",
    "do it",
    "can you fix the failing test",
    "could you add the tests",
    "should be quick, go ahead",
    "when done, open the pr",
  ]) {
    test(prompt, () => {
      expect(isQuestionTurn(prompt)).toBe(false);
      expect(verdictFor("Done. Say the word", prompt)).toEqual({
        kind: "warning",
        closer: "Say the word",
      });
    });
  }
});

test("one warning per turn", () => {
  expect(
    classify({
      assistantText: "Want me to continue?",
      userPrompt: "carry on",
      warnedThisTurn: true,
    }),
  ).toEqual({ kind: "skip", reason: "already-warned" });
});
