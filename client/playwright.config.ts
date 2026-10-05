import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// E2E SPA: chromium, все /api/* перехватываются моками (helpers.mockApi) —
// реальная сеть и LLM не задействуются, поэтому прокси vite на :3000 не нужен.
// Live-смоук (@live, реальный ход ~₽0.3) исключён без TH_LIVE=1.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    // Грабля 03.10: bundled-браузер не скачан (корп. self-signed TLS),
    // рекордер уже на системном Chrome — e2e тоже (channel: "chrome").
    channel: "chrome",
  },
  grep: process.env.TH_LIVE ? undefined : /^(?!.*@live)/,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Из корня: сборка shared → vite dev :5173 (скрипт dev:spa уже существует).
    command: "npm run dev:spa",
    url: "http://localhost:5173/",
    cwd: repoRoot,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
