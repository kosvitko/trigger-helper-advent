import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Юнит-тесты сторов (Svelte 5 runes в *.svelte.ts) — компиляция тем же
// svelte-плагином, что и в vite.config.ts. Окружение happy-dom (не jsdom):
// старт заметно быстрее, а сторам хватает sessionStorage/fetch/crypto —
// layout и браузерные сценарии живут в e2e (playwright), DOM здесь не нужен.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // svelte отдаёт браузерные сборки только по browser-условию;
    // vitest исполняет код в node — без этого условия руны ломаются.
    conditions: ["browser"],
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
