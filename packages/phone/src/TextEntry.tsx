import { forwardRef, useState } from "react";
import type { KapulaTextControl } from "@kapula/protocol";
import { KAPULA_TEXT_MAX_LENGTH } from "@kapula/protocol";

type TextEntryProps = {
  control: KapulaTextControl;
  onSend: (text: string) => void;
  onClose: () => void;
};

/**
 * The field a `text` control opens: a bar along the top of the controller
 * box with the player's own keyboard under it (the OS keyboard on a phone,
 * the real one on a laptop). "Send" or Enter delivers the whole text and
 * clears the field for the next answer; it stays open until closed, so a
 * run of answers needs no re-tapping. The keyboard is allowed to cover the
 * controls below — nothing is re-laid out around it.
 *
 * The input is focused by the caller, synchronously inside the tap that
 * opened it (see `Controller`): iOS shows the keyboard only for a focus
 * that happens in a user gesture, never for one from an effect.
 */
export const TextEntry = forwardRef<HTMLInputElement, TextEntryProps>(
  ({ control, onSend, onClose }, ref) => {
    const [text, setText] = useState("");
    const maxLength = control.maxLength ?? KAPULA_TEXT_MAX_LENGTH;
    return (
      <form
        data-testid={`text-entry-${control.id}`}
        className="absolute top-0 inset-x-0 z-20 flex items-center gap-2 p-2 bg-kp-bg-secondary border-b border-kp-border"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.length === 0) return;
          onSend(text);
          setText("");
        }}
      >
        <input
          ref={ref}
          data-testid={`text-input-${control.id}`}
          className="flex-1 min-w-0 px-3 py-2 text-base rounded-kp bg-kp-bg-primary border border-kp-border text-kp-text-primary"
          value={text}
          maxLength={maxLength}
          placeholder={control.label ?? "Type here"}
          enterKeyHint="send"
          onChange={(e) => setText(e.target.value.slice(0, maxLength))}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        />
        <button
          type="submit"
          data-testid={`text-send-${control.id}`}
          disabled={text.length === 0}
          className="px-3 py-2 rounded-kp bg-kp-accent-primary text-kp-accent-on-primary font-bold disabled:opacity-40"
        >
          Send
        </button>
        <button
          type="button"
          data-testid={`text-close-${control.id}`}
          className="px-2 py-2 text-kp-text-secondary"
          onClick={onClose}
          aria-label="Close the text field"
        >
          ✕
        </button>
      </form>
    );
  },
);
TextEntry.displayName = "TextEntry";
