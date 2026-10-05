import type {
  AgentMessage,
  ChatTaskState,
  ChatTaskStatePatch,
  LlmUsage,
} from "@trigger-helper/shared";
import type { ChatMessage, DeepSeekService } from "../deepseek.js";

/**
 * Day25 (design D-4, Q-c): лёгкая память задачи мини-чата — {goal, clarified,
 * constraints_terms}. Ключ — threadAgentId (диалог, не агент-шаблон, 02-F-4):
 * форкнутый поток получает свою память. Экстракт — classify-паттерн дня 10/11
 * (temp 0.1, ≤400 out, fail-open), дедуп — Jaccard 0.7 по образцу
 * memory-state.ts:20–29/:96–140. Инжект — один system-блок ≤~600 симв.
 * (паттерн buildTaskStateMessage), после task-блока. FSM дня 13 не переиспользуем.
 */

/** Day10/11 classify-паттерн: та же пара констант (llm-agent.ts:53–57). */
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

/** Инжект-блок ≤~600 симв. (паттерн buildTaskStateMessage, llm-agent.ts:446). */
const CHAT_TASK_CHAR_BUDGET = 600;
const CHAT_TASK_HEADER = "## Память задачи";

function emptyState(): ChatTaskState {
  return { goal: "", clarified: [], constraints_terms: [] };
}

function copyState(s: ChatTaskState): ChatTaskState {
  return {
    goal: s.goal,
    clarified: [...s.clarified],
    constraints_terms: [...s.constraints_terms],
  };
}

/** Token-set Jaccard ≥ 0.7 — зеркало similarFactText (memory-state.ts:20–29). */
function similarText(a: string, b: string): boolean {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.7;
}

function tokenSet(text: string): Set<string> {
  // 041005 (Костя: дубли-парафразы в «Уточнено»): лёгкий стемминг — токены
  // ≥4 символов режутся до первых 3 («болит/боль» → «бол»). Семантические
  // парафразы ловит промпт-слой («Уже в памяти»), это — лексическая страховка.
  return new Set(
    text
      .trim()
      .toLowerCase()
      .split(/[^0-9a-zа-яё]+/)
      .filter((t) => t.length > 1)
      .map((t) => (t.length >= 4 ? t.slice(0, 3) : t)),
  );
}

function clipItem(text: string, cap: number): string {
  const t = text.trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

/** Дедуп-слияние списков (Jaccard 0.7), кап длины — как в памяти слоёв. */
function mergeList(existing: string[], incoming: string[], cap: number): string[] {
  const out = [...existing];
  for (const raw of incoming) {
    const item = clipItem(raw, 160);
    if (!item) continue;
    if (out.some((t) => t === item || similarText(t, item))) continue;
    out.push(item);
    if (out.length >= cap) break;
  }
  return out.slice(-cap);
}

export type ChatTaskStateOptions = {
  onChange?: () => void;
};

/**
 * Память задачи мини-чата — in-memory Map + снапшот в var/agent-state.json
 * (persistence.ts, поле chatTaskStates). Ключ ${instanceId}|${threadAgentId} —
 * тот же shape, что у ThreadStore.
 */
export class ChatTaskStateStore {
  private readonly byKey = new Map<string, ChatTaskState>();
  private readonly onChange: (() => void) | undefined;

  constructor(opts: ChatTaskStateOptions = {}) {
    this.onChange = opts.onChange;
  }

  get(instanceId: string, threadAgentId: string): ChatTaskState {
    const s = this.byKey.get(this.key(instanceId, threadAgentId));
    return s ? copyState(s) : emptyState();
  }

  /** PATCH панели «Память задачи» (02b-F-1): absent = keep. */
  patch(
    instanceId: string,
    threadAgentId: string,
    patch: ChatTaskStatePatch,
  ): ChatTaskState {
    const prev = this.get(instanceId, threadAgentId);
    const next: ChatTaskState = {
      goal: patch.goal !== undefined ? patch.goal.trim().slice(0, 300) : prev.goal,
      clarified:
        patch.clarified !== undefined
          ? patch.clarified.map((s) => s.trim()).filter(Boolean).slice(0, 8)
          : prev.clarified,
      constraints_terms:
        patch.constraints_terms !== undefined
          ? patch.constraints_terms.map((s) => s.trim()).filter(Boolean).slice(0, 8)
          : prev.constraints_terms,
    };
    this.byKey.set(this.key(instanceId, threadAgentId), next);
    this.onChange?.();
    return copyState(next);
  }

  /** Экстракт хода → дедуп-апселт (upsertFromClassify-паттерн). */
  upsertExtracted(
    instanceId: string,
    threadAgentId: string,
    extracted: ChatTaskExtract,
  ): ChatTaskState {
    const prev = this.get(instanceId, threadAgentId);
    const goal = extracted.goal?.trim();
    const next: ChatTaskState = {
      goal: goal ? clipItem(goal, 300) : prev.goal,
      clarified: mergeList(prev.clarified, extracted.clarified ?? [], 8),
      constraints_terms: mergeList(
        prev.constraints_terms,
        extracted.constraints_terms ?? [],
        8,
      ),
    };
    this.byKey.set(this.key(instanceId, threadAgentId), next);
    this.onChange?.();
    return copyState(next);
  }

  snapshot(): Record<string, ChatTaskState> {
    const out: Record<string, ChatTaskState> = {};
    for (const [k, v] of this.byKey) out[k] = copyState(v);
    return out;
  }

  load(slice: Record<string, ChatTaskState>): void {
    this.byKey.clear();
    for (const [k, v] of Object.entries(slice)) {
      this.byKey.set(k, copyState(v));
    }
  }

  private key(instanceId: string, threadAgentId: string): string {
    return `${instanceId}|${threadAgentId}`;
  }
}

export function createChatTaskStateStore(
  opts: ChatTaskStateOptions = {},
): ChatTaskStateStore {
  return new ChatTaskStateStore(opts);
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
