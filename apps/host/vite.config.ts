import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The phone web app of the reference host. In development the server
 * (src/main.ts) runs Vite in middleware mode on top of this config; a
 * production build lands in dist/web and is served statically.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web", emptyOutDir: true, target: "es2020" },
});
