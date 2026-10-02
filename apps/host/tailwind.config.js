import kapulaPreset from "@kapula/phone/tailwind-preset";

/** @type {import('tailwindcss').Config} */
export default {
  presets: [kapulaPreset],
  content: {
    // Relative to this file: the host is started from the repository root.
    relative: true,
    files: [
      "./index.html",
      "./web/**/*.{ts,tsx}",
      // The published package's compiled screens: their class names must be
      // scanned too, or the controller renders unstyled.
      "../../packages/phone/dist/**/*.js",
    ],
  },
};
