import { describe, expect, test } from "bun:test";

import { classify, findCloser, isIrreversible, isQuestionTurn } from "./classify.ts";

const NOT_A_QUESTION = "carry on";

function verdictFor(assistantText: string, userPrompt = NOT_A_QUESTION) {
  return classify({ assistantText, userPrompt, nudgedThisTurn: false });
}

describe("closer phrases", () => {
  const cases: { phrase: string; text: string }[] = [
    { phrase: "say the word", text: "Say the word and it is done." },
    { phrase: "want me to", text: "Want me to take it from here?" },
    { phrase: "would you like me to", text: "Would you like me to run the suite?" },
    { phrase: "should i", text: "Should I continue with the tests?" },
    { phrase: "shall i", text: "Shall I proceed?" },
    { phrase: "offer stands", text: "The offer stands." },
    { phrase: "may i", text: "May I keep going?" },
    { phrase: "do you want me to", text: "Do you want me to push the branch?" },
    { phrase: "let me know if you'd like", text: "Let me know if you'd like a summary." },
    { phrase: "let me know if you would like", text: "Let me know if you would like a summary." },
    { phrase: "if you want, i can", text: "If you want, I can finish it." },
    { phrase: "if you want i can", text: "If you want I can finish it." },
    { phrase: "happy to", text: "Happy to finish the refactor if you want." },
  ];

  for (const { phrase, text } of cases) {
    test(`"${phrase}" nudges`, () => {
      const verdict = verdictFor(text);
      expect(verdict.nudge).toBe(true);
      if (verdict.nudge) expect(verdict.closer.toLowerCase()).toBe(phrase);
    });
  }
});

describe("tail window", () => {
  test("a closer 2000 characters before the end does not nudge", () => {
    const assistantText = `Say the word.${"x".repeat(2000)}`;
    expect(findCloser(assistantText)).toBeNull();
    expect(verdictFor(assistantText)).toEqual({ nudge: false, reason: "no-closer" });
  });
});

describe("no closer", () => {
  test("a plain summary does not nudge", () => {
    expect(verdictFor("Done. The diff is above.")).toEqual({ nudge: false, reason: "no-closer" });
  });
});

describe("irreversible work", () => {
  test("Say the word and I merge is irreversible", () => {
    expect(verdictFor("Say the word and I merge")).toEqual({
      nudge: false,
      reason: "irreversible",
    });
  });

  test("Should I force-push is irreversible", () => {
    expect(verdictFor("Should I force-push the branch?")).toEqual({
      nudge: false,
      reason: "irreversible",
    });
  });

  test("isIrreversible matches the keyword list", () => {
    const sentences = [
      "I will deploy it",
      "I can delete that file",
      "drop the table",
      "rm -rf /tmp",
      "reset --hard",
      "customer data",
      "payment is due",
      "billing address",
      "production",
      "prod",
      "revert the change",
      "force push",
    ];
    for (const sentence of sentences) expect(isIrreversible(sentence)).toBe(true);
  });

  test("isIrreversible passes reversible sentences", () => {
    expect(isIrreversible("I will run the tests")).toBe(false);
  });
});

describe("question turns", () => {
  const prompts = [
    "explain this",
    "why does x?",
    "how does it work",
    "is it green?",
    "no changes yet, just look",
  ];

  for (const userPrompt of prompts) {
    test(`"${userPrompt}" skips the nudge`, () => {
      expect(
        classify({ assistantText: "Want me to continue?", userPrompt, nudgedThisTurn: false }),
      ).toEqual({ nudge: false, reason: "question-turn" });
    });
  }

  test("isQuestionTurn classifies prefixes and trailing question marks", () => {
    expect(isQuestionTurn("  Explain this  ")).toBe(true);
    expect(isQuestionTurn("WHY")).toBe(true);
    expect(isQuestionTurn("No changes yet, just look")).toBe(true);
    expect(isQuestionTurn("This ends with a question?")).toBe(true);
    expect(isQuestionTurn("carry on")).toBe(false);
  });

  const imperatives = [
    "do this now then",
    "do it",
    "can you fix the failing test",
    "could you add the tests",
    "should be quick, go ahead",
  ];

  for (const userPrompt of imperatives) {
    test(`"${userPrompt}" nudges on a trailing offer`, () => {
      expect(isQuestionTurn(userPrompt)).toBe(false);
      expect(verdictFor("Done. Say the word", userPrompt)).toEqual({
        nudge: true,
        closer: "Say the word",
      });
    });
  }
});

describe("guards", () => {
  test("an already nudged turn does not nudge again", () => {
    expect(
      classify({
        assistantText: "Want me to continue?",
        userPrompt: NOT_A_QUESTION,
        nudgedThisTurn: true,
      }),
    ).toEqual({ nudge: false, reason: "already-nudged" });
  });
});

describe("capitalization and punctuation", () => {
  test("upper-case closers still match", () => {
    expect(findCloser("SAY THE WORD!!!")).toBe("SAY THE WORD");
    expect(findCloser("should i...")).toBe("should i");
    expect(findCloser("SHALL I GO AHEAD?!")).toBe("SHALL I");
  });

  test("trailing punctuation does not hide a closer", () => {
    expect(verdictFor("Done. Want me to take it from here...")).toEqual({
      nudge: true,
      closer: "Want me to",
    });
  });
});
