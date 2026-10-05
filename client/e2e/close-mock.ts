/**
 * Тестовый хелпер для close/undo-спеков: базовый mockApi (все /api/*) плюс
 * верхний слой роутов закрытия/восстановления. Playwright пробует роуты в
 * порядке LIFO — этот хелпер регистрируется ПОСЛЕ mockApi, поэтому получает
 * запрос первым; неподходящие пути уходят в route.fallback() → базовый мок.
 * Формы ответов — те же контракты, что у сервера: DELETE возвращает снапшот
 * {agent, messages} / {instance, threads}, POST-restore — эхо снапшота (201).
 */
import type { BrowserContext, Route } from "@playwright/test";
import type { AgentMessage, Instance } from "@trigger-helper/shared";
import { e2eInstances } from "./fixtures";
import { mockApi, type ApiCall, type MockApi, type MockApiOptions } from "./helpers";

export interface CloseMockApi extends MockApi {
  /** Журнал обработанных close/restore-запросов (DELETE + extraThreads-GET). */
  closeCalls: ApiCall[];
}

export interface CloseMockOptions extends MockApiOptions {
  /** Доп. треды поверх базового мока, ключ `instanceId/agentId`. */
  extraThreads?: Record<string, AgentMessage[]>;
}

const threadEnvelope = (instanceId: string, agentId: string, messages: AgentMessage[]) => ({
  instanceId,
  agentId,
  threadAgentId: agentId,
  messages,
  facts: {},
  branch: { forked: false, activeBranchId: null, checkpointCount: 0 },
  contextStrategy: "sliding",
});

export async function mockApiWithClose(
  context: BrowserContext,
  opts: CloseMockOptions = {},
): Promise<CloseMockApi> {
  const api = await mockApi(context, opts);
  const closeCalls: ApiCall[] = [];
  const json = (route: Route, v: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(v) });
  const instanceList = (): Instance[] =>
    (opts.instances as { instances?: Instance[] } | undefined)?.instances ?? e2eInstances().instances;

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

    // GET messages: extraThreads-тред (напр. тред соседнего агента / высокие баблы)
    const mMsgs = path.match(/^\/api\/instances\/([^/]+)\/agents\/([^/]+)\/messages$/);
    if (mMsgs && method === "GET") {
      const instId = decodeURIComponent(mMsgs[1]);
      const agentId = decodeURIComponent(mMsgs[2]);
      const extra = opts.extraThreads?.[`${instId}/${agentId}`];
      if (extra) return json(route, threadEnvelope(instId, agentId, extra));
      return route.fallback();
    }

    // POST restore: инстанс или агент — сервер возвращает эхо снапшота (201)
    if (path === "/api/instances/restore" && method === "POST") {
      closeCalls.push({ method, path, body });
      const b = (body ?? {}) as { instance?: unknown; threads?: unknown };
      return json(route, { instance: b.instance, threads: b.threads ?? {} }, 201);
    }

    // DELETE /api/instances/:id/agents/:agentId → снапшот {agent, messages}
    const mAgent = path.match(/^\/api\/instances\/([^/]+)\/agents\/([^/]+)$/);
    if (mAgent && method === "POST") {
      // POST …/agents/restore → эхо снапшота агента (201)
      closeCalls.push({ method, path, body });
      const b = (body ?? {}) as { agent?: unknown; messages?: unknown };
      return json(route, { agent: b.agent, messages: b.messages ?? [] }, 201);
    }
    if (mAgent && method === "DELETE") {
      closeCalls.push({ method, path, body });
      const instId = decodeURIComponent(mAgent[1]);
      const agentId = decodeURIComponent(mAgent[2]);
      const agent = instanceList().find((i) => i.id === instId)?.agents.find((a) => a.id === agentId);
      if (!agent) return json(route, { error: `close-mock: агент ${agentId} не найден` }, 404);
      return json(route, { agent, messages: [] });
    }

    // DELETE /api/instances/:id → снапшот {instance, threads}
    const mInst = path.match(/^\/api\/instances\/([^/]+)$/);
    if (mInst && method === "DELETE") {
      closeCalls.push({ method, path, body });
      const instId = decodeURIComponent(mInst[1]);
      const inst = instanceList().find((i) => i.id === instId);
      if (!inst) return json(route, { error: `close-mock: инстанс ${instId} не найден` }, 404);
      return json(route, { instance: inst, threads: {} });
    }

    return route.fallback();
  });

  return { ...api, closeCalls };
}
