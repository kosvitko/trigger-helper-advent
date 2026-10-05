// Тестовая утилита: мок глобального fetch с маршрутизацией по path/method.
// Только для юнит-тестов; e2e перехватывает /api на уровне playwright-route.
import { vi } from "vitest";

export interface FetchCall {
  method: string;
  url: string;
  /** Распарсенное JSON-тело (или сырое, если не JSON). */
  body: unknown;
}

export interface StubResponse {
  status?: number;
  json?: unknown;
  /** Сырой текст тела (для тестов не-JSON ответов). */
  text?: string;
}

export interface StubRoute {
  url: string | RegExp;
  method?: string;
  status?: number;
  json?: unknown;
  text?: string;
  /**
   * Динамический ответ: считаем попытки (ретраи), можно вернуть промис —
   * например, deferred-ответ для проверки гонок (резолвить извне).
   * Бросок/реджект = сетевой сбой fetch.
   */
  respond?: (call: FetchCall, attempt: number) => Promise<StubResponse> | StubResponse;
}

export interface FetchStub {
  calls: FetchCall[];
  callsTo(url: string | RegExp, method?: string): FetchCall[];
}

/** Подменяет global.fetch; все запросы идут только по заданным маршрутам. */
export function stubFetch(routes: StubRoute[]): FetchStub {
  const calls: FetchCall[] = [];
  const attempts = new Map<StubRoute, number>();
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: FetchCall = { method, url, body };
    calls.push(call);
    // Два прохода: сначала точное совпадение пути, потом подстрока/regex —
    // иначе «/api/instances» перехватывает и «…/messages» (массив порядка).
    const matches = (r: StubRoute, exact: boolean): boolean => {
      const methodOk = !r.method || r.method.toUpperCase() === method;
      const urlOk = exact
        ? url === r.url
        : typeof r.url === "string"
          ? url.includes(r.url)
          : r.url.test(url);
      return methodOk && urlOk;
    };
    const exact = routes.find((r) => matches(r, true));
    // Свободный проход: среди совпавших берём самый длинный строковый путь
    // (иначе «/api/instances» перехватит и «…/agents/…/messages»).
    const loose = routes
      .filter((r) => matches(r, false))
      .sort((a, b) => (typeof b.url === "string" ? b.url.length : 1e9) - (typeof a.url === "string" ? a.url.length : 1e9));
    const route = exact ?? loose[0];
    if (route) {
      const r = route;
      attempts.set(r, (attempts.get(r) ?? 0) + 1);
      const res = r.respond
        ? await r.respond(call, attempts.get(r) ?? 1)
        : { status: r.status, json: r.json, text: r.text };
      const status = res.status ?? 200;
      const textBody = res.text ?? (res.json !== undefined ? JSON.stringify(res.json) : "");
      return new Response(textBody, {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`fetch-stub: нет маршрута для ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return {
    calls,
    callsTo(url, method) {
      return calls.filter(
        (c) =>
          (typeof url === "string" ? c.url.includes(url) : url.test(c.url)) &&
          (!method || c.method === method.toUpperCase()),
      );
    },
  };
}
