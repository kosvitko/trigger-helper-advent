import fs from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "../config/env.js";
import { createDeepSeekService } from "../services/deepseek.js";
import { createUsageLedgerService } from "../services/usage-ledger.js";
import { getBudgetSnapshot } from "../services/cost-aware-throttle.js";
import { createRagService, writeJsonAtomic } from "../services/rag/store.js";
import { repoRoot } from "../services/rag/paths.js";
import { normalizeRu } from "../services/rag/text.js";
import { createRagAnswerService } from "../services/rag/answer.js";
import { createReranker } from "../services/rag/rerank.js";
import { createRewriteQueries } from "../services/rag/rewrite.js";
import { createLlmAgent } from "../services/agent/llm-agent.js";
import { createThreadStore } from "../services/agent/threads.js";
import { createMemoryStateStore } from "../services/agent/memory-state.js";
import {
  createChatTaskStateStore,
} from "../services/agent/chat-task-state.js";
import {
  createAgentStateStore,
  type AgentStateSnapshot,
} from "../services/agent/persistence.js";
import { AGENT_PRESETS, getPreset } from "../services/agent/presets.js";
import type { RagToolPayload } from "../services/agent/rag-tool.js";
import type { AgentInstance } from "@trigger-helper/shared";

/**
 * Day25 chat-level eval (design D-6, Δ-6): 2 сценария × 12 сообщений против
 * агента пресета rag_chat. Драйвер собирает ТУ ЖЕ границу хода, что и роут
 * (02-F-10): memory classify → rag_ask-тур (локальная тулза) → наррация →
 * экстракт ChatTaskState; ThreadStore + persistence (отдельный файл, не
 * var/agent-state.json сервера).
 *
 *   npm run rag:eval-chat    (сервер должен быть остановлен)
 *
 * Пин 05-M-1: авто-сжатие в драйвере выключено — compressEvery=0; routes-шаг
 * auto-compress в драйвер не входит (отклонение паритета задокументировано
 * в артефакте). Прямой вызов сервисов, без HTTP и rate-limit (F-05-2).
 *
 * Автопроверки на каждый ход — та же детекция, что у рельсы (D-3):
 *  - rag_ask вызван;
 *  - реплика упоминает ≥1 фактическую метку [source › section] из payload
 *    последнего успешного rag_ask; exemption: dontKnow ИЛИ ok:false (05-M-5);
 *    ok:false и после re-prompt → счётчик toolFailures, НЕ railViolated;
 *  - sources/quotes валидны (payload структурно непуст);
 *  - к сообщению 15 цель/ограничения живы в ChatTaskState (ключ threadAgentId).
 * Нарушений рельсы в сценариях цель = 0 (meta.railViolated). Артефакт:
 * data/rag/eval-chat.json.
 */

const OUT_FILE =
  process.argv.find((a) => a.startsWith("--out="))?.split("=")[1] ??
  "data/rag/eval-chat.json";
/** Отдельный state-файл драйвера — НЕ var/agent-state.json продукта. */
const DRIVER_STATE_FILE =
  process.argv.find((a) => a.startsWith("--state="))?.split("=")[1] ??
  "data/rag/eval-chat-agent-state.json";

type ScenarioTurn = {
  n: number;
  /** Сценарный номер сообщения пользователя (1-based, сквозной). */
  messageNo: number;
  q: string;
  reply: string;
  ragCalled: boolean;
  ragQuestion: string | null;
  dontKnow: boolean;
  okFalse: boolean;
  exempt: boolean;
  sourcesMentioned: boolean | null;
  sourcesValid: boolean | null;
  quotesValid: boolean | null;
  railViolated: boolean;
  toolFailures: number;
  ragTokens: number | null;
  runTokens: number;
  extractTokens: number | null;
  latencyMs: number;
};

type Scenario = {
  id: string;
  title: string;
  turns: string[];
  rows: ScenarioTurn[];
  aliveAt15: boolean | null;
  chatTaskState: { goal: string; clarified: string[]; constraints_terms: string[] };
};

const S1_TURNS = [
  "Постоянно ноет шея сзади справа, к вечеру боль отдаёт в голову. Что это может быть по базе и что делать?",
  "Какая мышца чаще всего даёт такую боль с отдачей в голову?",
  "Как её найти — где именно нажимать, чтобы было «больно-приятно»?",
  "Покажи технику самомассажа: сколько минут, с какой силой и как часто?",
  "А если при надавливании головная боль усиливается — это норма или стоп-сигнал?",
  "Боль теперь чаще у лопатки и сбоку шеи. Это другая мышца?",
  "Какую мышцу стоит проверить рядом с лопаткой и как её отпустить?",
  "Есть ли растяжка, которую можно делать прямо на работе за столом?",
  "Сколько дней делать техники, прежде чем ждать эффект?",
  // off-corpus ход: рельса требует вызов rag_ask, dontKnow-гейт → честное «не знаю».
  "Кстати, расскажи, как устроены квантовые вычисления на кубитах.",
  "Вернёмся к шее: что сделать утром, если шея заклинила после сна?",
  "Итог: составь короткий план на неделю по шее и лопатке, с источниками.",
];

const S2_TURNS = [
  "Хочу разобраться в терминах: что вы называете триггерной точкой?",
  "Учти ограничение: у меня гипертония — никаких техник с задержкой дыхания и сильной болью.",
  "Под «точкой» я понимаю только ощутимое уплотнение под пальцами, не общее напряжение мышцы.",
  "Какие точки связаны с болью в жевательных мышцах? Я сильно сжимаю челюсть ночью.",
  "Как найти триггерную точку в жевательной мышце самому?",
  "Есть ли техника для челюсти без сильного давления, с учётом моего ограничения?",
  "Что такое «ишемическое сжатие» и безопасно ли оно при гипертонии?",
  "Распиши по шагам технику для челюсти с таймингом.",
  "Уточнение по термину: «referred pain» — это боль, отдающая от точки в другое место, верно?",
  "Какие стоп-сигналы для техник на лице и шее при моём давлении?",
  "Проверь по базе: можно ли совмещать работу с челюстью и шеей в один день?",
  "Итог: перечисли мои ограничения и термины, которые надо учитывать, и дай план на челюсть.",
];

/** Живость памяти к сообщению 15: цель или ограничения/термины непусты. */
function taskStateAlive(state: { goal: string; clarified: string[]; constraints_terms: string[] }): boolean {
  return (
    state.goal.trim().length > 0 ||
    state.clarified.length > 0 ||
    state.constraints_terms.length > 0
  );
}

async function main(): Promise<number> {
  const env = loadEnv();
  const deepSeek = createDeepSeekService(env);
  const ledger = createUsageLedgerService(env.USAGE_FILE);
  const ragAnswer = createRagAnswerService({
    rag: createRagService(env),
    deepSeek,
    ledger,
    reranker: createReranker(env),
    rewriter: createRewriteQueries(deepSeek),
  });
  const llmAgent = createLlmAgent(
    deepSeek,
    env.DEEPSEEK_MODEL,
    env.DEMO_CONTEXT_LIMIT,
    undefined, // MCP-реестр не нужен: rag-ход ⇒ только локальная rag_ask
    ragAnswer,
  );

  // Та же граница хода, что роут: треды + память + ChatTaskState + снапшот.
  const agentState = createAgentStateStore(path.join(repoRoot, DRIVER_STATE_FILE));
  const threads = createThreadStore({ onChange: () => agentState.scheduleSave() });
  const memoryState = createMemoryStateStore({ onChange: () => agentState.scheduleSave() });
  const chatTaskStateStore = createChatTaskStateStore({
    onChange: () => agentState.scheduleSave(),
  });
  agentState.setSnapshotProvider((): AgentStateSnapshot => ({
    version: 1,
    saved_at: new Date().toISOString(),
    instance_seq: 0,
    agent_seq: {},
    instances: [],
    threads: threads.snapshotThreads(),
    facts: {},
    branching: {},
    strategyByAgent: {},
    memory: memoryState.snapshot(),
    profiles: {},
    taskStates: {},
    invariantStates: {},
    chatTaskStates: chatTaskStateStore.snapshot(),
  }));

  const preset = getPreset("rag_chat") ?? AGENT_PRESETS[0]!;
  const agent: AgentInstance = {
    id: "eval-rag-chat-agent",
    presetId: preset.id,
    label: preset.label,
    role: preset.role,
    instructions: preset.instructions,
    layers: preset.layers,
    inputPolicy: preset.inputPolicy,
    outputPolicy: preset.outputPolicy,
    defaultTemperature: preset.defaultTemperature,
  };
  const instanceId = "eval-day25";
  const threadAgentId = agent.id; // без branching — как resolveThreadAgentId без стратегии

  // Budget warn-only (F-B2): прямой вызов, без route-throttle.
  const budget = await getBudgetSnapshot(ledger, env);
  console.log(
    "[rag:eval-chat] бюджет дня: использовано ₽" + String(budget.used_rub) +
      " из ₽" + String(budget.limit_rub) +
      " · прогон 24 хода ≈ 9–12k ток/ход ≈ ₽10–13 (экономика design §4)",
  );
  console.log(
    "[rag:eval-chat] ledger — единый писатель: сервер должен быть остановлен (F-05-2)",
  );

  const scenarios: Scenario[] = [
    { id: "s1", title: "S1 «зона боли → техники» (follow-up'ы + off-corpus)", turns: S1_TURNS, rows: [], aliveAt15: null, chatTaskState: { goal: "", clarified: [], constraints_terms: [] } },
    { id: "s2", title: "S2 «термины и ограничения»", turns: S2_TURNS, rows: [], aliveAt15: null, chatTaskState: { goal: "", clarified: [], constraints_terms: [] } },
  ];

  let messageNo = 0;
  const t0 = Date.now();
  for (const scenario of scenarios) {
    const scenarioThreadId = `${threadAgentId}#${scenario.id}`;
    for (let i = 0; i < scenario.turns.length; i++) {
      const q = scenario.turns[i]!;
      messageNo += 1;
      process.stdout.write(
        `[rag:eval-chat] ${scenario.id} ход ${i + 1}/${scenario.turns.length} (сообщение ${messageNo}) … `,
      );
      const history = threads.list(instanceId, scenarioThreadId);

      // Route-parity: memory classify до рана (fail-open).
      let classifyTokens: number | null = null;
      try {
        const classified = await llmAgent.classifyMemoryFacts({
          userText: q,
          historyTail: history,
          model: env.DEEPSEEK_MODEL,
        });
        if (classified.usage) {
          classifyTokens = classified.usage.total_tokens;
          await ledger.record(classified.usage, { countExpensive: false });
        }
        if (classified.items.length > 0) {
          memoryState.upsertFromClassify(instanceId, scenarioThreadId, classified.items, {
            historySeq: history.length,
          });
        }
      } catch {
        /* fail-open, как в роуте */
      }
      const memorySlice = memoryState.get(instanceId, scenarioThreadId);
      const chatTaskState = chatTaskStateStore.get(instanceId, scenarioThreadId);

      threads.append(
        instanceId,
        scenarioThreadId,
        threads.createMessage({
          role: "user",
          content: q,
          agentId: agent.id,
          label: agent.label,
        }),
      );

      const result = await llmAgent.run(agent, q, history, {
        historyMode: "tail",
        tools: true,
        ragTool: true,
        memoryFacts: memorySlice.facts,
        chatTaskState,
      });
      await ledger.record(result.usage, { countExpensive: false });

      threads.append(
        instanceId,
        scenarioThreadId,
        threads.createMessage({
          role: "assistant",
          content: result.reply,
          agentId: agent.id,
          label: agent.label,
          model: result.model,
          latency_ms: result.latency_ms,
          usage: result.usage,
          cost_rub: result.cost_rub,
        }),
      );

      // Route-parity: экстракт памяти задачи in-request после рана (fail-open).
      let extractTokens: number | null = null;
      const extracted = await llmAgent.classifyChatTaskState({
        userText: q,
        assistantReply: result.reply,
        historyTail: history,
        model: env.DEEPSEEK_MODEL,
      });
      const nextState = chatTaskStateStore.upsertExtracted(
        instanceId,
        scenarioThreadId,
        extracted.extracted,
      );
      if (extracted.usage) {
        extractTokens = extracted.usage.total_tokens;
        await ledger.record(extracted.usage, { countExpensive: false });
      }

      // Автопроверки хода — та же детекция, что у рельсы (D-3/04-F-3).
      const calls = result.toolInject?.calls ?? [];
      const ragCalls = calls.filter((c) => c.name === "rag_ask");
      const lastRag = ragCalls[ragCalls.length - 1] ?? null;
      const payload = (lastRag?.payload ?? null) as RagToolPayload | null;
      const dontKnow = payload?.dontKnow === true;
      const okFalse = lastRag !== null && !lastRag.ok;
      const exempt = dontKnow || okFalse;
      const labels = payload?.labels ?? [];
      const normReply = normalizeRu(result.reply);
      const sourcesMentioned = exempt
        ? null
        : labels.some((l) => normReply.includes(normalizeRu(l)));
      const sourcesValid = exempt ? null : (payload?.sources?.length ?? 0) > 0;
      const quotesValid = exempt ? null : (payload?.quotes?.length ?? 0) > 0;
      const turnToolFailures = okFalse ? 1 : 0;

      scenario.rows.push({
        n: i + 1,
        messageNo,
        q,
        reply: result.reply,
        ragCalled: ragCalls.length > 0,
        ragQuestion: payload?.question ?? null,
        dontKnow,
        okFalse,
        exempt,
        sourcesMentioned,
        sourcesValid,
        quotesValid,
        railViolated: result.railViolated === true,
        toolFailures: turnToolFailures,
        ragTokens:
          payload?.usage &&
          typeof payload.usage === "object" &&
          "total_tokens" in payload.usage
            ? Number((payload.usage as { total_tokens: number }).total_tokens)
            : null,
        runTokens: result.usage.total_tokens,
        extractTokens,
        latencyMs: result.latency_ms,
      });

      // К сообщению 15 (S2, ход 3): цель/ограничения живы?
      if (messageNo === 15) {
        for (const s of scenarios) {
          s.aliveAt15 = taskStateAlive(
            chatTaskStateStore.get(instanceId, `${threadAgentId}#${s.id}`),
          );
        }
      }

      const flag = (v: boolean | null) => (v === null ? "—" : v ? "✓" : "✗");
      console.log(
        `rag ${flag(ragCalls.length > 0)} · ист ${flag(sourcesMentioned)} · ` +
          `dontKnow ${flag(dontKnow ? true : null)} · рельса ${flag(result.railViolated === true ? true : null)} · ` +
          `${result.usage.total_tokens} ток · ${(result.latency_ms / 1000).toFixed(1)} с`,
      );
    }
    scenario.chatTaskState = chatTaskStateStore.get(instanceId, scenarioThreadId);
  }
  await agentState.flush();

  const allRows = scenarios.flatMap((s) => s.rows);
  const aggregate = {
    turns: allRows.length,
    railViolations: allRows.filter((r) => r.railViolated).length,
    ragMisses: allRows.filter((r) => !r.ragCalled).length,
    sourceFails: allRows.filter((r) => r.sourcesMentioned === false).length,
    toolFailures: allRows.reduce((acc, r) => acc + r.toolFailures, 0),
    dontKnowTurns: allRows.filter((r) => r.dontKnow).length,
    runTokens: allRows.reduce((acc, r) => acc + r.runTokens, 0),
    ragTokens: allRows.reduce((acc, r) => acc + (r.ragTokens ?? 0), 0),
    extractTokens: allRows.reduce((acc, r) => acc + (r.extractTokens ?? 0), 0),
    durationMs: Date.now() - t0,
    budgetStartRub: budget.used_rub,
    /** 05-M-1: отклонение паритета — авто-сжатие выключено (compressEvery=0),
     *  routes-шаг auto-compress в драйвер не входит. */
    parityNote:
      "compressEvery=0 (05-M-1): auto-compress route step not included; manual UI runs (default 10) may show a compression banner mid-scenario — honest product behavior.",
  };
  const pass =
    aggregate.railViolations === 0 &&
    aggregate.ragMisses === 0 &&
    aggregate.sourceFails === 0 &&
    scenarios.every((s) => s.aliveAt15 !== false);

  const artifact = {
    generatedAt: new Date().toISOString(),
    model: env.DEEPSEEK_MODEL,
    preset: "rag_chat",
    strategy: "structured",
    k: 12,
    pass,
    aggregate,
    scenarios: scenarios.map((s) => ({
      id: s.id,
      title: s.title,
      aliveAt15: s.aliveAt15,
      chatTaskState: s.chatTaskState,
      rows: s.rows,
    })),
  };
  const outPath = path.join(repoRoot, OUT_FILE);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await writeJsonAtomic(outPath, artifact);
  console.log(
    `[rag:eval-chat] ${pass ? "PASS" : "FAIL"} · рельса ${aggregate.railViolations}/0 · ` +
      `rag ${aggregate.ragMisses}/0 miss · ист ${aggregate.sourceFails}/0 fail · ` +
      `toolFailures ${aggregate.toolFailures} · dontKnow ${aggregate.dontKnowTurns} · ` +
      `~${(aggregate.durationMs / 60_000).toFixed(1)} мин → ${OUT_FILE}`,
  );
  return pass ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
