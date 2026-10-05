/**
 * E2E-хелпер: перехват ВСЕХ /api/* на уровне browser-context — ноль реальной
 * сети, LLM не вызывается. Неперехваченный /api-путь получает 404-JSON
 * (в сеть не уходит в принципе, прокси vite на :3000 не задействуется).
 */
import type { BrowserContext, Route } from "@playwright/test";
import {
  AGENT_A2,
  AGENT_B,
  INST_A_ID,
  INST_B_ID,
  e2eChatTask,
  e2eEmptyThread,
  e2eInstances,
  e2eModels,
  e2eRagStats,
  e2eRunRag,
  e2eThreadA,
  e2eThreadB,
} from "./fixtures";

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

export interface MockApi {
  /** Журнал всех /api-запросов (для assert'ов «ровно один POST» и PATCH-тела). */
  calls: ApiCall[];
  /** Подменить реализацию run (по умолчанию — успешный rag-ответ). */
  setRun(impl: (body: { input?: string; instanceId?: string; agentId?: string }) => unknown): void;
}

export interface MockApiOptions {
  /** Задержка ответа /api/agent/run (мс) — окно для typing-индикатора. */
  runDelayMs?: number;
  /** Подменить GET /api/instances (например, пустой список). */
  instances?: unknown;
  /** Подменить POST /api/instances (например, кап-лимит 429). */
  createInstance?: { status: number; body: unknown };
  /** Пустые треды у обоих инстансов (чистая лента для подсчёта баблов). */
  emptyThreads?: boolean;
  /** Подменить GET /api/rag/stats (по умолчанию — реальная прод-форма). */
  ragStats?: unknown;
}

export async function mockApi(context: BrowserContext, opts: MockApiOptions = {}): Promise<MockApi> {
  const calls: ApiCall[] = [];
  let runImpl: (body: { input?: string }) => unknown = (body) =>
    e2eRunRag(String(body?.input ?? ""));
  const runDelayMs = opts.runDelayMs ?? 0;

  // Stateful-мок: run дописывает ход в тред агента — после reload лента
  // восстанавливается реалистично (как это делал бы настоящий сервер).
  const threads = new Map<string, Record<string, unknown>>([
    [`t/${INST_A_ID}/${AGENT_A2}`, opts.emptyThreads ? e2eEmptyThread(INST_A_ID, AGENT_A2) : e2eThreadA()],
    [`t/${INST_B_ID}/${AGENT_B}`, opts.emptyThreads ? e2eEmptyThread(INST_B_ID, AGENT_B) : e2eThreadB()],
  ]);
  const chatTasks = new Map<string, Record<string, unknown>>();

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

    if (path === "/api/models") return json(route, e2eModels());
    if (path === "/api/rag/stats") return json(route, opts.ragStats ?? e2eRagStats());
    if (path === "/api/instances" && method === "GET")
      return json(route, opts.instances ?? e2eInstances());
    if (path === "/api/instances" && method === "POST") {
      if (opts.createInstance) return json(route, opts.createInstance.body, opts.createInstance.status);
      const b = (body ?? {}) as { label?: string };
      return json(route, {
        instance: {
          id: "inst-new",
          label: b.label ?? "Демо · новая",
          createdAt: "2026-10-03T10:00:00.000Z",
          agents: [
            {
              id: "agent-new-rag",
              presetId: "rag_chat",
              label: "RAG-чат",
              role: "Помощник по самопомощи",
              instructions: "Отвечай по базе знаний.",
              layers: { strategic: "s", operational: "o", task: "t" },
              inputPolicy: { trim: true, maxChars: 4000, requireNonEmpty: true },
              outputPolicy: { trim: true, maxChars: 4000, formatHint: "soft" },
              defaultModel: "deepseek-chat",
              defaultTemperature: 0.3,
            },
          ],
        },
      });
    }

    const mMsgs = path.match(/^\/api\/instances\/([^/]+)\/agents\/([^/]+)\/messages$/);
    if (mMsgs && method === "GET") {
      const instId = decodeURIComponent(mMsgs[1]);
      const agentId = decodeURIComponent(mMsgs[2]);
      const th = threads.get(`t/${instId}/${agentId}`);
      return json(route, th ?? e2eEmptyThread(instId, agentId));
    }

    const mTask = path.match(/^\/api\/instances\/([^/]+)\/agents\/([^/]+)\/chat-task-state$/);
    if (mTask) {
      const key = `c/${decodeURIComponent(mTask[1])}/${decodeURIComponent(mTask[2])}`;
      if (method === "PATCH") {
        const cur = (chatTasks.get(key) ??
          e2eChatTask().chatTaskState) as Record<string, unknown>;
        const next = { ...cur, ...((body ?? {}) as Record<string, unknown>) };
        chatTasks.set(key, next);
        return json(route, { chatTaskState: next });
      }
      return json(route, { chatTaskState: chatTasks.get(key) ?? e2eChatTask().chatTaskState });
    }

    if (path === "/api/agent/run" && method === "POST") {
      const res = runImpl((body ?? {}) as { input?: string });
      const b = (body ?? {}) as { instanceId?: string; agentId?: string };
      const th = threads.get(`t/${b.instanceId}/${b.agentId}`);
      if (th) {
        const messages = (th as { messages: unknown[] }).messages;
        messages.push({
          id: `local-run-${calls.length}`,
          role: "user",
          content: b.input ?? "",
          createdAt: "2026-10-03T09:31:00.000Z",
        });
        messages.push((res as { message: unknown }).message);
      }
      if (runDelayMs > 0) await new Promise((r) => setTimeout(r, runDelayMs));
      return json(route, res);
    }

    // Непредвиденный /api-запрос: тест это увидит в calls, в сеть не пойдёт.
    return json(route, { error: `e2e-mock: unexpected ${method} ${path}` }, 404);
  });

  return { calls, setRun(impl) { runImpl = impl; } };
}
