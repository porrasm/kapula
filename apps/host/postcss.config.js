import { fileURLToPath } from "node:url";

// Tailwind looks for its config in the process cwd by default; the host is
// started from the repository root (npm workspaces), so point at ours.
export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL("./tailwind.config.js", import.meta.url)) },
    autoprefixer: {},
  },
};
