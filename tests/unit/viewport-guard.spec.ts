import { test, expect } from "@playwright/test";
import { isTextEntry } from "@kapula/phone/utils";

/**
 * The scroll guard must leave the window alone while the on-screen keyboard
 * is up (iOS scrolls the focused field into view on purpose) and reset it
 * for anything else that holds focus.
 */
test.describe("viewport guard", () => {
  test("keyboard-summoning elements count as text entry", () => {
    for (const tagName of ["INPUT", "input", "TEXTAREA", "SELECT"]) {
      expect(isTextEntry({ tagName })).toBe(true);
    }
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  test("buttons, the body and nothing at all do not", () => {
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntry({ tagName: "BODY", isContentEditable: false })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
