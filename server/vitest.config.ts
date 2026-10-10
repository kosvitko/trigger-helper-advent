import { defineConfig } from "vitest/config";

// Серверный unit-харнесс (гейт 261009, Pick A): node env, без DOM.
// Клиентский happy-dom / Svelte — в client/vitest.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
