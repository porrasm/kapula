import { test, expect } from "@playwright/test";
import {
  KAPULA_TEXT_MAX_LENGTH,
  controlSchemaSchema,
  kapulaPlayerClientMessageSchema,
  kapulaServerMessageSchema,
} from "@kapula/protocol";
import {
  describeServerMessage,
  recordInputFrame,
  recordTextMessage,
  type DebugInputs,
} from "@kapula/phone/utils";
import {
  canCustomizeLayout,
  needsLandscape,
  resolveLayout,
} from "@kapula/phone/utils";

/** The submit-only `text` control and its `text` messages. */

const schema = (controls: unknown[]) =>
  controlSchemaSchema.safeParse({ id: "quiz", name: "Quiz", controls });

test.describe("text control schema", () => {
  test("a text control is valid with or without its options", () => {
    expect(schema([{ type: "text", id: "answer" }]).success).toBe(true);
    expect(
      schema([
        {
          type: "text",
          id: "answer",
          label: "Answer",
          maxLength: 80,
          zone: "right",
          size: "large",
          shape: "rect",
          x: 50,
          y: 20,
        },
      ]).success,
    ).toBe(true);
  });

  test("maxLength is 1 up to the protocol ceiling", () => {
    expect(schema([{ type: "text", id: "a", maxLength: 0 }]).success).toBe(false);
    expect(
      schema([{ type: "text", id: "a", maxLength: KAPULA_TEXT_MAX_LENGTH }]).success,
    ).toBe(true);
    expect(
      schema([{ type: "text", id: "a", maxLength: KAPULA_TEXT_MAX_LENGTH + 1 }])
        .success,
    ).toBe(false);
    expect(schema([{ type: "text", id: "a", maxLength: 1.5 }]).success).toBe(false);
  });
});

test.describe("text messages", () => {
  test("the player sends a whole text for one control", () => {
    const parse = (v: unknown) => kapulaPlayerClientMessageSchema.safeParse(v).success;
    expect(parse({ type: "text", controlId: "answer", text: "Helsinki" })).toBe(true);
    expect(parse({ type: "text", controlId: "answer", text: "" })).toBe(true);
    expect(parse({ type: "text", controlId: "answer", text: "ä😀\n" })).toBe(true);
    expect(
      parse({
        type: "text",
        controlId: "answer",
        text: "x".repeat(KAPULA_TEXT_MAX_LENGTH + 1),
      }),
    ).toBe(false);
    expect(parse({ type: "text", controlId: "Bad Id", text: "x" })).toBe(false);
    expect(parse({ type: "text", controlId: "answer" })).toBe(false);
  });

  test("the driver receives it with the player id", () => {
    const parse = (v: unknown) => kapulaServerMessageSchema.safeParse(v).success;
    expect(
      parse({ type: "text", playerId: "p1", controlId: "answer", text: "Helsinki" }),
    ).toBe(true);
    expect(parse({ type: "text", controlId: "answer", text: "Helsinki" })).toBe(false);
  });
});

test.describe("text control layout", () => {
  const quiz = controlSchemaSchema.parse({
    id: "quiz",
    name: "Quiz",
    controls: [
      { type: "text", id: "answer", label: "Answer" },
      { type: "button", id: "yes", label: "Yes" },
    ],
  });

  test("it is laid out as a button and is editable", () => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      const layout = resolveLayout(quiz, viewport);
      const answer = layout.controls.find((c) => c.control.id === "answer")!;
      expect(answer.role).toBe("primary");
      expect(answer.width).toBeGreaterThan(0);
    }
    expect(canCustomizeLayout({ disallowLayoutCustomization: false }, quiz)).toBe(true);
  });

  test("it counts as a button for the orientation heuristic", () => {
    const five = controlSchemaSchema.parse({
      id: "five",
      name: "Five",
      controls: [
        { type: "text", id: "t" },
        ...[1, 2, 3, 4].map((n) => ({ type: "button", id: `b${n}`, label: `B${n}` })),
      ],
    });
    expect(needsLandscape(quiz)).toBe(false);
    expect(needsLandscape(five)).toBe(true);
  });
});

test.describe("debug driver text readout", () => {
  const msg = (text: string) =>
    ({ type: "text", playerId: "p1", controlId: "answer", text }) as const;

  test("keeps the latest text per control, across input frames", () => {
    let inputs: DebugInputs = {};
    inputs = recordTextMessage(inputs, msg("first"));
    inputs = recordInputFrame(
      inputs,
      { type: "input", playerId: "p1", seq: 1, controls: { yes: true } },
      1000,
    );
    expect(inputs.p1.texts).toEqual({ answer: "first" });
    inputs = recordTextMessage(inputs, msg("second"));
    expect(inputs.p1.texts).toEqual({ answer: "second" });
    expect(inputs.p1.seq).toBe(1);
  });

  test("logs each text", () => {
    expect(describeServerMessage(msg("hi"), null)).toBe('p1 sent answer: "hi"');
  });
});
