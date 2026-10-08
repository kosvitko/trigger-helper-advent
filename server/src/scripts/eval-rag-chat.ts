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
import {
  CHAT_PRESETS,
  getChatPreset,
  mergeChatTaskDelta,
  mergeFactDelta,
  type AgentInstance,
  type AgentMessage,
  type ChatTaskState,
  type FactRow,
  type FactTombstone,
} from "@trigger-helper/shared";
import type { RagToolPayload } from "../services/agent/rag-tool.js";

/**
 * Day25 chat-level eval (design D-6, Δ-6): 2 сценария × 12 сообщений против
 * агента пресета rag_chat. C+ CH-6: драйвер собирает ТУ ЖЕ границу хода,
 * что и stateless POST /api/chat (routes/chat.ts): локальный contextTail
 * (dialogue + memory.facts + chatTask) → run → memoryDelta (classify +
 * extract ПОСЛЕ рана, как в ходе) → merge тех же shared-хелперов, что у
 * клиента (mergeFactDelta/mergeChatTaskDelta). Серверные сторы больше
 * не существуют (D-10); state драйвера — в памяти, артефакт на диске.
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
 *  - к сообщению 15 цель/ограничения живы в ChatTaskState (локальный merge).
 * Нарушений рельсы в сценариях цель = 0 (meta.railViolated). Артефакт:
 * data/rag/eval-chat.json.
 */

const OUT_FILE =
  process.argv.find((a) => a.startsWith("--out="))?.split("=")[1] ??
  "data/rag/eval-chat.json";

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

type ScenarioState = {
  /** Локальный contextTail.dialogue (после последней сводки; сводок нет). */
  dialogue: { role: "user" | "assistant"; content: string }[];
  /** Локальная память фактов — merge через mergeFactDelta (как клиент). */
  facts: FactRow[];
  factTombstones: FactTombstone[];
  /** Локальная память задачи — merge через mergeChatTaskDelta (как клиент). */
  chatTask: ChatTaskState;
};

type Scenario = {
  id: string;
  title: string;
  turns: string[];
  rows: ScenarioTurn[];
  aliveAt15: boolean | null;
  chatTaskState: { goal: string; clarified: string[]; constraints_terms: string[] };
  state: ScenarioState;
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

function emptyScenarioState(): ScenarioState {
  return {
    dialogue: [],
    facts: [],
    factTombstones: [],
    chatTask: { goal: "", clarified: [], constraints_terms: [] },
  };
}

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

  const preset = getChatPreset("rag_chat") ?? CHAT_PRESETS[0]!;
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
    { id: "s1", title: "S1 «зона боли → техники» (follow-up'ы + off-corpus)", turns: S1_TURNS, rows: [], aliveAt15: null, chatTaskState: { goal: "", clarified: [], constraints_terms: [] }, state: emptyScenarioState() },
    { id: "s2", title: "S2 «термины и ограничения»", turns: S2_TURNS, rows: [], aliveAt15: null, chatTaskState: { goal: "", clarified: [], constraints_terms: [] }, state: emptyScenarioState() },
  ];

  let messageNo = 0;
  const t0 = Date.now();
  for (const scenario of scenarios) {
    const st = scenario.state;
    for (let i = 0; i < scenario.turns.length; i++) {
      const q = scenario.turns[i]!;
      messageNo += 1;
      process.stdout.write(
        `[rag:eval-chat] ${scenario.id} ход ${i + 1}/${scenario.turns.length} (сообщение ${messageNo}) … `,
      );

      // Граница хода как в /api/chat: хвост = локальный диалог без текущего
      // вопроса; summaries нет (compressEvery=0, пин 05-M-1).
      const history: AgentMessage[] = st.dialogue.map((m, idx) => ({
        id: `msg-${idx}`,
        role: m.role,
        content: m.content,
        createdAt: new Date().toISOString(),
      }));
      const historySeq = st.dialogue.length;

      const result = await llmAgent.run(agent, q, history, {
        historyMode: "full",
        tools: true,
        ragTool: true,
        memoryFacts: st.facts,
        chatTaskState: st.chatTask,
      });
      await ledger.record(result.usage, { countExpensive: false });

      // memoryDelta хода (паритет /api/chat: classify + extract ПОСЛЕ рана,
      // fail-open; merge — те же shared-хелперы, что у клиента).
      let extractTokens: number | null = null;
      const classified = await llmAgent
        .classifyMemoryFacts({
          userText: q,
          historyTail: history,
          model: env.DEEPSEEK_MODEL,
        })
        .catch(() => ({ ok: false as const, items: [] }));
      if ("usage" in classified && classified.usage) {
        await ledger.record(classified.usage, { countExpensive: false });
      }
      // Паритет /api/chat (routes/chat.ts memoryDelta.facts): кап 16 Items
      // в ответе хода — драйвер мержит тот же срез, что получил бы клиент.
      const mergedFacts = mergeFactDelta(
        st.facts,
        classified.items.slice(0, 16),
        {
          historySeq,
          deleted: st.factTombstones,
        },
      );
      st.facts = mergedFacts.facts;
      st.factTombstones = mergedFacts.deleted;

      const extracted = await llmAgent
        .classifyChatTaskState({
          userText: q,
          assistantReply: result.reply,
          historyTail: history,
          model: env.DEEPSEEK_MODEL,
          current: st.chatTask,
        })
        .catch(() => ({ ok: false as const, extracted: {} as Record<string, never> }));
      if ("usage" in extracted && extracted.usage) {
        extractTokens = extracted.usage.total_tokens;
        await ledger.record(extracted.usage, { countExpensive: false });
      }
      st.chatTask = mergeChatTaskDelta(st.chatTask, extracted.extracted);

      // Ход записан локально (как applyTurnResult клиента).
      st.dialogue.push({ role: "user", content: q });
      st.dialogue.push({ role: "assistant", content: result.reply });

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
          s.aliveAt15 = taskStateAlive(s.state.chatTask);
        }
      }

      const flag = (v: boolean | null) => (v === null ? "—" : v ? "✓" : "✗");
      console.log(
        `rag ${flag(ragCalls.length > 0)} · ист ${flag(sourcesMentioned)} · ` +
          `dontKnow ${flag(dontKnow ? true : null)} · рельса ${flag(result.railViolated === true ? true : null)} · ` +
          `${result.usage.total_tokens} ток · ${(result.latency_ms / 1000).toFixed(1)} с`,
      );
    }
    scenario.chatTaskState = st.chatTask;
  }

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
