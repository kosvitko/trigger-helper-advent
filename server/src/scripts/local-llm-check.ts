import { loadEnv } from "../config/env.js";
import {
  chatLocalLlm,
  isLocalCatalogId,
  LOCAL_LLM_DEFAULT_MODEL,
  LOCAL_LLM_CATALOG,
  localLlmConfig,
  probeLocalLlm,
} from "../services/local-llm.js";

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
 *
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

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(
      `FAIL: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
