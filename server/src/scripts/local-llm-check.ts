import { loadEnv } from "../config/env.js";
import {
  chatLocalLlm,
  isLocalCatalogId,
  LOCAL_LLM_DEFAULT_MODEL,
  LOCAL_LLM_CATALOG,
  localLlmConfig,
  localRagRetrieve,
  probeLocalLlm,
} from "../services/local-llm.js";
import { createReranker } from "../services/rag/rerank.js";
import { createRagService } from "../services/rag/store.js";

/**
 * День 26 — живая проверка локальной LLM (design §2.1, D-26-6):
 * 3 запроса разной сложности к рантайму Ollama — (1) простой факт по тексту
 * карточки базы, (2) суммаризация текста карточки, (3) рассуждение по фактам
 * базы (data/points: infraspinatus.md, deltoideus.md; сухой прогон на 1.5b
 * 08.10: параметрика домена у 1.5b ненадёжна — вопросы заземлены на текст).
 * Ответ стримится
 * в консоль, в конце — таблица токены/латентность. Недоступный рантайм
 * → exit 1 («pending runtime» — не падение сборки).
 *
 * Run: npm run local-llm:check            (модель — дефолт каталога 0.5b)
 *      npm run local-llm:check -- --model qwen2.5:1.5b
 *      npm run local-llm:check -- --history [--model …] (день 27: диалог из
 *        2 ходов — ход 2 «почему?» содержательно требует хода 1; PASS =
 *        ответы непустые И prompt_tokens вырос — история доехала до Ollama)
 *      npm run local-llm:check -- --rag [--model …] (день 28: retrieval по
 *        базе (localRagRetrieve, тот же конвейер, что в /api/chat) → ход
 *        с контекстом против хода без контекста; PASS = ответ непуст И
 *        prompt_tokens RAG-хода > хода без контекста — контекст доехал.
 *        Качество текста маленькой модели — НЕ метрика (day26/day27).)
 * Модель берётся из КАТАЛОГА (дефолт qwen2.5:0.5b), не из env — env может
 * задавать только адрес рантайма/таймаут/kill-switch (OLLAMA_URL,
 * OLLAMA_TIMEOUT_MS, LOCAL_LLM_ENABLED).
 */

interface CheckQuery {
  title: string;
  q: string;
}

const QUERIES: CheckQuery[] = [
  {
    title: "Простой факт",
    q: [
      "Прочитай: До деактивации точек не растягивайте плечо: подостная мышца плохо",
      "переносит раздражение, растяжка контрпродуктивна.",
      "Можно ли растягивать плечо до деактивации точек? Ответь да или нет.",
    ].join(" "),
  },
  {
    title: "Суммаризация",
    q: [
      "Сожми абзац в одно предложение.",
      "Абзац: Подостная мышца лежит сзади, на лопатке. Её отражённая боль ощущается",
      "спереди, в плечевом суставе, и спускается по руке.",
      "Поэтому при боли в плече мышцу проверяют сзади, на лопатке.",
    ].join(" "),
  },
  {
    title: "Рассуждение по фактам базы",
    q: [
      "Из базы: подостная — боль отдаёт далеко от точки, например спереди в плечевый",
      "сустав, хотя мышца лежит сзади на лопатке. Дельтовидная — боль домашняя:",
      "сидит рядом с точкой и почти не отдаёт.",
      "У клиента боль отдаёт далеко от точки — спереди в плечевый сустав.",
      "Какая мышца вероятнее — подостная или дельтовидная? Ответь одним словом.",
    ].join(" "),
  },
];

interface CheckRow {
  title: string;
  deltas: number;
  promptTokens: number;
  completionTokens: number;
  totalMs: number;
}

function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(1).replace(".", ",");
}

async function main(): Promise<number> {
  const env = loadEnv();
  const config = localLlmConfig(env);

  const modelArgIdx = process.argv.indexOf("--model");
  const model =
    modelArgIdx >= 0 ? (process.argv[modelArgIdx + 1] ?? "") : LOCAL_LLM_DEFAULT_MODEL;
  if (!isLocalCatalogId(model)) {
    console.error(
      `Неизвестная модель "${model}" — каталог: ${LOCAL_LLM_CATALOG.map((e) => e.id).join(", ")}`,
    );
    return 2;
  }

  console.log(`Модель: ${model} · рантайм: ${config.baseUrl}`);

  const probe = await probeLocalLlm(env);
  const entry = probe.entries.find((e) => e.id === model);
  if (!probe.enabled || !probe.runtimeOk) {
    console.error(
      !probe.enabled
        ? "SKIP: локальная ветка отключена (LOCAL_LLM_ENABLED=0/false)."
        : `SKIP: рантайм Ollama недоступен (${config.baseUrl}) — pending runtime.`,
    );
    return 1;
  }
  if (entry && !entry.installed) {
    console.error(
      `SKIP: модель ${model} не установлена — выполните: ollama pull ${model}`,
    );
    return 1;
  }

  // День 27 (proposals 261009 §3.1-3): режим мульти-хода — wiring-проверка
  // истории вместо 3 отдельных запросов.
  if (process.argv.includes("--history")) {
    return runHistoryCheck(env, model);
  }

  // День 28 (proposals 261009 §3.1-1): режим RAG — wiring-проверка контекста
  // (тот же паттерн, что --history: факт доезда виден по prompt_tokens).
  if (process.argv.includes("--rag")) {
    return runRagCheck(env, model);
  }

  const rows: CheckRow[] = [];
  for (let i = 0; i < QUERIES.length; i += 1) {
    const { title, q } = QUERIES[i];
    console.log(`\n[${i + 1}/${QUERIES.length}] ${title}`);
    console.log("─".repeat(72));
    let deltas = 0;
    const result = await chatLocalLlm(env, { model, q }, (delta) => {
      deltas += 1;
      process.stdout.write(delta);
    });
    process.stdout.write("\n");
    rows.push({
      title,
      deltas,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalMs: result.totalMs,
    });
    console.log(
      `→ ● ${deltas} дельт · prompt ${result.promptTokens} · completion ${result.completionTokens} · ${fmtSec(result.totalMs)} с`,
    );
  }

  console.log("\nИтог (токены/латентность):");
  console.log("| # | Запрос                   | Дельт | Prompt | Compl | Латентность |");
  console.log("|---|--------------------------|-------|--------|-------|-------------|");
  rows.forEach((row, i) => {
    const title = row.title.padEnd(24).slice(0, 24);
    console.log(
      `| ${i + 1} | ${title} | ${String(row.deltas).padStart(5)} | ${String(row.promptTokens).padStart(6)} | ${String(row.completionTokens).padStart(5)} | ${fmtSec(row.totalMs).padStart(9)} с |`,
    );
  });
  return 0;
}

/** День 27: диалог из 2 ходов через ту же chatLocalLlm, что и продукт
 * (proposals 261009 §3.1-3). Ход 2 «почему?» содержательно требует хода 1.
 * Пара V2 (сухой прогон 09.10, temp/dryrun-day27-candidates.mjs: 5/5 на 1.5b;
 * V1 «да/нет» флюкнула — грабля day26). PASS = оба ответа непустые И
 * prompt_tokens хода 2 > хода 1 (история реально уехала в Ollama — wiring,
 * качество текста 0.5b не метрика, day26). */
async function runHistoryCheck(
  env: ReturnType<typeof loadEnv>,
  model: string,
): Promise<number> {
  const q1 = QUERIES[1].q;
  const q2 =
    "Почему мышцу проверяют сзади, на лопатке, хотя болит спереди? Опираясь на предыдущий ход, ответь одним предложением.";

  console.log("\n[1/2] Ход 1 (суммаризация карточки) — без истории");
  console.log("─".repeat(72));
  const a1 = await chatLocalLlm(env, { model, q: q1 }, (d) =>
    process.stdout.write(d),
  );
  process.stdout.write("\n");
  console.log(
    `→ prompt ${a1.promptTokens} · completion ${a1.completionTokens} · ${fmtSec(a1.totalMs)} с`,
  );

  console.log("\n[2/2] Ход 2 («почему?») — с историей хода 1");
  console.log("─".repeat(72));
  const a2 = await chatLocalLlm(
    env,
    {
      model,
      q: q2,
      history: [
        { role: "user", content: q1 },
        { role: "assistant", content: a1.reply },
      ],
    },
    (d) => process.stdout.write(d),
  );
  process.stdout.write("\n");
  console.log(
    `→ prompt ${a2.promptTokens} · completion ${a2.completionTokens} · ${fmtSec(a2.totalMs)} с`,
  );

  if (!a1.reply.trim() || !a2.reply.trim()) {
    console.error("FAIL: пустой ответ локальной модели");
    return 1;
  }
  if (a2.promptTokens <= a1.promptTokens) {
    console.error(
      `FAIL: prompt_tokens не вырос (${a1.promptTokens} → ${a2.promptTokens}) — история не доехала`,
    );
    return 1;
  }
  console.log(
    `PASS: история доехала (prompt ${a1.promptTokens} → ${a2.promptTokens} ток)`,
  );
  return 0;
}

/** День 28: один вопрос по базе (on-corpus контрольный, косинус top-1 выше
 * порога гейта — tune-dontknow.json on-01) → retrieval (localRagRetrieve,
 * тот же конвейер, что локальная ветка /api/chat) → два хода той же модели:
 * без контекста и с SEC-F3-контекстом. PASS = ответ с контекстом непуст И
 * prompt_tokens вырос — контекст реально доехал в Ollama (качество текста
 * 0.5b — не метрика, day26). */
async function runRagCheck(
  env: ReturnType<typeof loadEnv>,
  model: string,
): Promise<number> {
  const q =
    "Сухой приступообразный кашель может быть от триггерной точки? В какой мышце?";

  console.log("\n[1/2] Ход без контекста — тот же вопрос");
  console.log("─".repeat(72));
  const a1 = await chatLocalLlm(env, { model, q }, (d) =>
    process.stdout.write(d),
  );
  process.stdout.write("\n");
  console.log(
    `→ prompt ${a1.promptTokens} · completion ${a1.completionTokens} · ${fmtSec(a1.totalMs)} с`,
  );

  console.log("\n[2/2] Retrieval + ход с контекстом (localRagRetrieve)");
  console.log("─".repeat(72));
  const rag = createRagService(env);
  const reranker = createReranker(env);
  const retrieval = await localRagRetrieve(rag, reranker, q);
  if (retrieval.dontKnow) {
    console.error(
      `FAIL: dontKnow-гейт (косинус top-1 ${retrieval.topCosine} < порога ${retrieval.threshold}) — контекста нет, wiring не проверить`,
    );
    return 1;
  }
  console.log(
    `→ retrieval: пул ${retrieval.poolRanked} → в контексте ${retrieval.injectedCount} · косинус top-1 ${retrieval.topCosine} · ${fmtSec(retrieval.latencyMs)} с (реранк ${fmtSec(retrieval.rerankLatencyMs)} с)`,
  );
  const a2 = await chatLocalLlm(
    env,
    { model, q, context: retrieval.contextBlock },
    (d) => process.stdout.write(d),
  );
  process.stdout.write("\n");
  console.log(
    `→ prompt ${a2.promptTokens} · completion ${a2.completionTokens} · ${fmtSec(a2.totalMs)} с`,
  );

  if (!a2.reply.trim()) {
    console.error("FAIL: пустой ответ локальной модели с контекстом");
    return 1;
  }
  if (a2.promptTokens <= a1.promptTokens) {
    console.error(
      `FAIL: prompt_tokens не вырос (${a1.promptTokens} → ${a2.promptTokens}) — контекст не доехал`,
    );
    return 1;
  }
  console.log(
    `PASS: контекст доехал (prompt ${a1.promptTokens} → ${a2.promptTokens} ток, ${retrieval.injectedCount} фрагментов базы)`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(
      `FAIL: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
