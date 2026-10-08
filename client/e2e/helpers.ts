/**
 * E2E-хелпер (C+ CH-5b): перехват ВСЕХ /api/* на уровне browser-context —
 * ноль реальной сети, LLM не вызывается. Приложение stateless: справочники
 * (models / rag-stats / agents-meta) + единственный ход POST /api/chat —
 * плоский JSON ChatResponse (клиент парсит не-SSE-ответ как JSON) или
 * SSE-поток (opts.sse: step-события + done + [DONE]). Неперехваченный
 * /api-путь получает 404-JSON (в сеть не уходит в принципе).
 *
 * Локальные треды (th.threads.v1 / th.threadState.v1) сеются в localStorage
 * ДО загрузки страницы — seedLocalData (context.addInitScript, guarded-write:
 * пишет только при отсутствии ключа, reload не затирает персист приложения).
 */
import type { BrowserContext, Route } from "@playwright/test";
import type { AddressInfo } from "node:net";
import http from "node:http";
import type { ChatThreadRecord } from "@trigger-helper/shared";
import { e2eAgentsMeta, e2eChatLocal, e2eChatRag, e2eModels, e2eRagStats } from "./fixtures";

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

/** Тело POST /api/chat (поля, которые specs'ам нужны для assert'ов). */
export interface ChatRequestBody {
  input?: string;
  preset?: string;
  contextTail?: {
    summaries?: string[];
    dialogue?: { role: string; content: string }[];
    [k: string]: unknown;
  };
  overrides?: Record<string, unknown>;
  compress?: boolean;
  clientTurnId?: string;
  [k: string]: unknown;
}

export interface MockChat {
  /** Журнал всех /api-запросов (unexpected-404 тоже виден здесь). */
  calls: ApiCall[];
  /** Только POST /api/chat (тела — для assert'ов contextTail/compress/clientTurnId). */
  get chatCalls(): ApiCall[];
  /** Подменить ответ хода (по умолчанию — успешный rag-ответ на input). */
  setChat(impl: (body: ChatRequestBody) => unknown): void;
}

export interface MockChatOptions {
  /** Задержка ответа POST /api/chat (мс) — окно для typing-индикатора. */
  chatDelayMs?: number;
  /** POST /api/chat → SSE-поток (step-события + done) вместо плоского JSON. */
  sse?: boolean;
  /** День 26: вместе с sse — ЖИВОЙ стрим local-gen-кадров «● N ток» с
   *  паузами между кадрами. route.fulfill отдал бы тело одним куском —
   *  шаги обработались бы синхронно с done и не отрисовались бы; поэтому
   *  поток отдаёт локальный node-SSE-сервер через route.continue. */
  localProgress?: boolean;
  /** Подменить GET /api/models. */
  models?: unknown;
  /** Подменить GET /api/rag/stats (по умолчанию — реальная прод-форма). */
  ragStats?: unknown;
  /** Подменить GET /api/agents (мета-справочник пресетов). */
  agentsMeta?: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* — День 26: ленивый локальный SSE-сервер (один на процесс воркера).
   Кадры local-gen приходят с паузами — окно для assert'ов прогресса
   «● N ток»; финал — done с e2eChatLocal. — */
let localSsePort: Promise<number> | null = null;

function localProgressServer(): Promise<number> {
  localSsePort ??= new Promise<number>((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        let input = "";
        try {
          input = String((JSON.parse(raw) as ChatRequestBody)?.input ?? "");
        } catch {
          /* тело не распарсилось — финал с пустым input */
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const frame = (event: unknown): void => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        frame({ type: "step", step: "local-gen", text: "● 4 ток · 0,4 с" });
        setTimeout(() => frame({ type: "step", step: "local-gen", text: "● 18 ток · 2,1 с" }), 900);
        setTimeout(() => {
          frame({ type: "done", result: e2eChatLocal(input) });
          res.write("data: [DONE]\n\n");
          res.end();
        }, 1800);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return localSsePort;
}

export async function mockChat(context: BrowserContext, opts: MockChatOptions = {}): Promise<MockChat> {
  const calls: ApiCall[] = [];
  let chatImpl: (body: ChatRequestBody) => unknown = (body) =>
    e2eChatRag(String(body?.input ?? ""));
  const chatDelayMs = opts.chatDelayMs ?? 0;

  const json = (route: Route, v: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(v) });

  await context.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    let body: unknown;
    const postData = req.postData();
    if (postData) {
      try {
        body = JSON.parse(postData);
      } catch {
        body = postData;
      }
    }
    calls.push({ method, path, body });

    if (path === "/api/models" && method === "GET") return json(route, opts.models ?? e2eModels());
    if (path === "/api/rag/stats" && method === "GET")
      return json(route, opts.ragStats ?? e2eRagStats());
    if (path === "/api/agents" && method === "GET")
      return json(route, opts.agentsMeta ?? e2eAgentsMeta());

    if (path === "/api/chat" && method === "POST") {
      if (opts.sse && opts.localProgress) {
        // Живой стрим с паузами между кадрами (см. localProgress выше):
        // ответ сервера проксируется в страницу как есть (SSE-ридер
        // клиента читает кадры по мере прихода).
        const port = await localProgressServer();
        return route.continue({ url: `http://127.0.0.1:${port}${path}` });
      }
      const res = chatImpl((body ?? {}) as ChatRequestBody);
      if (chatDelayMs > 0) await sleep(chatDelayMs);
      if (opts.sse) {
        const events = [
          { type: "step", step: "start", text: "вопрос принят" },
          { type: "step", step: "rag_rewrite", text: "вариантов 2" },
          { type: "step", step: "narrative", text: "генерация ответа" },
          { type: "done", result: res },
        ];
        const sseBody = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody });
      }
      return json(route, res);
    }

    // Непредвиденный /api-запрос: тест это увидит в calls, в сеть не пойдёт.
    return json(route, { error: `e2e-mock: unexpected ${method} ${path}` }, 404);
  });

  return {
    calls,
    get chatCalls() {
      return calls.filter((c) => c.method === "POST" && c.path === "/api/chat");
    },
    setChat(impl) {
      chatImpl = impl;
    },
  };
}

/* — Посев локального состояния (треды/память) до загрузки страницы — */

export interface LocalThreadStateRecord {
  id: string;
  memory?: { facts: unknown[]; deleted: unknown[] };
  chatTask?: { goal: string; clarified: string[]; constraints_terms: string[] };
  /** Задача-FSM (день 13) и инварианты (день 14) — per-тред, C+ хвосты. */
  task?: unknown;
  invariants?: unknown[];
}

export interface SeedOptions {
  /** Записи th.threads.v1 (ChatThreadRecord); активный по умолчанию — новейший. */
  threads?: ChatThreadRecord[];
  /** Записи th.threadState.v1 (память/память задачи per-тред). */
  threadState?: LocalThreadStateRecord[];
}

/**
 * Засеять localStorage ДО первого скрипта страницы. Guarded-write: ключ
 * пишется только при отсутствии — после boot'а хранилище принадлежит
 * приложению, reload не откатывает его изменения (персист честно тестируется).
 */
export async function seedLocalData(context: BrowserContext, opts: SeedOptions = {}): Promise<void> {
  const threads = opts.threads ?? [];
  const states = opts.threadState ?? [];
  await context.addInitScript(
    (payload: { threads: unknown[]; states: unknown[] }) => {
      try {
        if (!localStorage.getItem("th.threads.v1")) {
          localStorage.setItem(
            "th.threads.v1",
            JSON.stringify({ version: 1, records: payload.threads }),
          );
        }
        if (payload.states.length > 0 && !localStorage.getItem("th.threadState.v1")) {
          localStorage.setItem(
            "th.threadState.v1",
            JSON.stringify({ version: 1, records: payload.states }),
          );
        }
      } catch {
        /* localStorage недоступен — чистый старт */
      }
    },
    { threads, states },
  );
}

/** Активный тред (id из селектора шапки) — он же префикс data-turn-id ходов. */
export async function activeThreadId(page: import("@playwright/test").Page): Promise<string> {
  const value = await page.locator("select.session").inputValue();
  if (!value) throw new Error("активный тред не выбран (селектор пуст)");
  return value;
}
