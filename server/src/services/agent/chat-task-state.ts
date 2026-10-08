import type {
  AgentMessage,
  ChatTaskState,
  LlmUsage,
} from "@trigger-helper/shared";
import type { ChatMessage, DeepSeekService } from "../deepseek.js";

/**
 * Day25 (design D-4, Q-c): лёгкая память задачи мини-чата — {goal, clarified,
 * constraints_terms}. C+ CH-6 (D-10): серверное хранилище снято (хранение и
 * merge — на клиенте, shared/schemas/merge.ts); здесь остались только чистые
 * куски LLM-конвейера, которые нужны llm-agent в stateless-ходе /api/chat:
 * экстракт (classify-паттерн дня 10/11: temp 0.1, ≤400 out, fail-open) и
 * инжект-блок ≤~600 симв. FSM дня 13 не переиспользуем.
 */

/** Day10/11 classify-паттерн: та же пара констант (llm-agent.ts). */
const EXTRACT_MAX_TOKENS = 400;
const EXTRACT_TEMPERATURE = 0.1;

const EXTRACT_SYSTEM_PROMPT = [
  "Из реплик ПОЛЬЗОВАТЕЛЯ (чат базы знаний самопомощи: зона боли, триггерные точки, техники) обнови память задачи диалога. Ответы ассистента — НЕ источник памяти: его советы, дисклеймеры и предостережения не записывать.",
  "Ответь ТОЛЬКО JSON-объектом {\"goal\",\"clarified\",\"constraints_terms\"}:",
  "- goal — цель диалога одной строкой (≤200 симв.; пустая строка, если цели не видно); жалоба, задающая тему диалога («болит голова») — это цель/контекст, НЕ уточнение;",
  "- clarified — ТОЛЬКО НОВЫЕ уточнения пользователя (мышца, сторона, длительность, характер, обстоятельства), которых ещё НЕТ в блоке «Уже в памяти» ниже: не повторяй известное другими словами, не добавляй перефразировки прежних запросов (просьба «попроще/пальцем» уже учтена — не фиксируй повторно); если нового нет — пустой массив;",
  "- constraints_terms — ограничения и зафиксированные термины, которые ввёл сам ПОЛЬЗОВАТЕЛЬ («нельзя задержку дыхания», «под точкой понимаю только уплотнение»); если он их не говорил — пусто.",
  "Только факты из реплик пользователя, без выдумок и персональных данных. Пустые массивы OK.",
].join("\n");

/** Инжект-блок ≤~600 симв. (паттерн buildTaskStateMessage, llm-agent.ts). */
const CHAT_TASK_CHAR_BUDGET = 600;
const CHAT_TASK_HEADER = "## Память задачи";

function clipItem(text: string, cap: number): string {
  const t = text.trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

/** Сырой экстракт хода (до дедупа); пустой = факта нет. */
export type ChatTaskExtract = {
  goal?: string;
  clarified?: string[];
  constraints_terms?: string[];
};

export type ChatTaskExtractResult = {
  ok: boolean;
  extracted: ChatTaskExtract;
  usage?: LlmUsage;
  latency_ms?: number;
};

function normalizeExtract(parsed: unknown): ChatTaskExtract {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const o = parsed as Record<string, unknown>;
  const listOf = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim())
      : [];
  return {
    ...(typeof o.goal === "string" && o.goal.trim() ? { goal: o.goal.trim() } : {}),
    ...(listOf(o.clarified).length ? { clarified: listOf(o.clarified).slice(0, 8) } : {}),
    ...(listOf(o.constraints_terms).length
      ? { constraints_terms: listOf(o.constraints_terms).slice(0, 8) }
      : {}),
  };
}

/**
 * Экстракт памяти задачи — один маленький LLM-вызов сразу после run()
 * (02-F-6, in-request). Fail-open: любая ошибка/битый JSON → пустой экстракт,
 * состояние не меняется; caller'у не кидает.
 */
export async function extractChatTaskState(
  deepSeek: DeepSeekService,
  params: {
    userText: string;
    assistantReply: string;
    historyTail: AgentMessage[];
    model: string;
    /** Текущее состояние — в промпт («Уже в памяти»): экстрактор не
     *  пере-добавляет известное парафразом (041005, фидбек Кости). */
    current?: ChatTaskState;
  },
): Promise<ChatTaskExtractResult> {
  const tail = params.historyTail
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-4);
  const cur = params.current;
  const memoryBlock =
    cur && (cur.goal || cur.clarified.length || cur.constraints_terms.length)
      ? [
          "## Уже в памяти (НЕ повторяй это в clarified/constraints — только существенно новое):",
          cur.goal ? `Цель: ${cur.goal}` : "",
          ...(cur.clarified.length ? ["Уточнено:", ...cur.clarified.map((c) => `- ${c}`)] : []),
          ...(cur.constraints_terms.length
            ? ["Ограничения:", ...cur.constraints_terms.map((c) => `- ${c}`)]
            : []),
        ]
          .filter(Boolean)
          .join("\n")
      : "";
  const transcript = [
    ...(memoryBlock ? [memoryBlock, ""] : []),
    ...tail.map(
      (m) => `${m.role === "user" ? "Пользователь" : "Агент"}: ${m.content}`,
    ),
    `Пользователь: ${params.userText.trim()}`,
    `Агент: ${params.assistantReply.trim()}`,
  ].join("\n\n");

  try {
    const result = await deepSeek.chat(
      [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
      {
        maxTokens: EXTRACT_MAX_TOKENS,
        temperature: EXTRACT_TEMPERATURE,
        model: params.model,
        jsonMode: true,
      },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.reply);
    } catch {
      return { ok: false, extracted: {}, usage: result.usage, latency_ms: result.latency_ms };
    }
    return {
      ok: true,
      extracted: normalizeExtract(parsed),
      usage: result.usage,
      latency_ms: result.latency_ms,
    };
  } catch {
    return { ok: false, extracted: {} };
  }
}

/**
 * Инжект-блок «Память задачи» — один system-блок ≤600 симв., после task-блока.
 * Ничего не эмитит без содержимого — дни 06–24 байт-в-байт.
 */
export function buildChatTaskStateMessage(state: ChatTaskState): ChatMessage | null {
  const goal = state.goal.trim();
  const clarified = state.clarified.filter(Boolean);
  const constraints = state.constraints_terms.filter(Boolean);
  if (!goal && clarified.length === 0 && constraints.length === 0) return null;

  const lines: string[] = [];
  if (goal) lines.push(`Цель: ${goal}`);
  if (clarified.length > 0) {
    lines.push("Уточнено:");
    for (const c of clarified) lines.push(`- ${clipItem(c, 160)}`);
  }
  if (constraints.length > 0) {
    lines.push("Ограничения и термины (учитывай в каждом ответе):");
    for (const c of constraints) lines.push(`- ${clipItem(c, 160)}`);
  }
  let content = `${CHAT_TASK_HEADER}\n${lines.join("\n")}`;
  if (content.length > CHAT_TASK_CHAR_BUDGET) {
    content = `${content.slice(0, CHAT_TASK_CHAR_BUDGET - 1)}…`;
  }
  return { role: "system", content };
}
