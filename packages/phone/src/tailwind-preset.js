/**
 * Tailwind preset for the Kapula player screens: the kp-* utilities they are
 * styled with, all reading the CSS variables in kapula.css. A host adds it to
 * its own Tailwind config (`presets: [kapulaPreset]`) and includes this
 * folder in `content`; the monorepo does both in frontend/tailwind.config.js.
 */
const rgb = (name) => `rgb(var(--kp-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: [],
  theme: {
    extend: {
      colors: {
        kp: {
          bg: {
            primary: rgb("bg-primary"),
            secondary: rgb("bg-secondary"),
            tertiary: rgb("bg-tertiary"),
            hover: rgb("bg-hover"),
          },
          text: {
            primary: rgb("text-primary"),
            secondary: rgb("text-secondary"),
            muted: rgb("text-muted"),
          },
          border: {
            DEFAULT: rgb("border"),
            light: rgb("border-light"),
            dark: rgb("border-dark"),
          },
          accent: {
            primary: rgb("accent-primary"),
            "primary-hover": rgb("accent-primary-hover"),
            "on-primary": rgb("accent-on-primary"),
            success: rgb("accent-success"),
            "success-light": rgb("accent-success-light"),
            warning: rgb("accent-warning"),
            danger: rgb("accent-danger"),
            "danger-light": rgb("accent-danger-light"),
          },
        },
      },
      borderRadius: {
        kp: "var(--kp-radius)",
        "kp-lg": "var(--kp-radius-lg)",
      },
      boxShadow: {
        "kp-card": "var(--kp-shadow-card)",
      },
    },
  },
};
