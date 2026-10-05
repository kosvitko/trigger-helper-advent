import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Проводка §3.1 F-1 + S3 root-swap (04.10): base "/" — SPA на «/», тот же
// билд раздаётся и на «/app» (ассеты абсолютные, сервер — index.ts).
// dev-прокси /api на существующий Fastify :3000 — сервер без правок.
export default defineConfig({
  plugins: [svelte()],
  base: "/",
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
