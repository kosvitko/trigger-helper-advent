/**
 * C+ (CH-5b): API-клиент stateless-хода `POST /api/chat`
 * (контракты — shared/schemas/chat.ts).
 *
 * Транспорт: SSE (Accept: text/event-stream) — step-события в onStep,
 * финал — ChatResponse; ошибки после hijack — событие {type:"error",
 * code, httpStatus, message} (04-MAJ-2) → ChatApiError. Ошибки ДО hijack
 * (429 rate-limit, 400 schema_invalid, 413, 502) — реальный HTTP
 * (05-MINOR-4): не-OK статус читается из JSON-тела {code, message}.
 */
import {
  ChatResponseSchema,
  ChatSseEventSchema,
  type ChatRequest,
  type ChatResponse,
  type ChatSseErrorCode,
} from "@trigger-helper/shared";

/** Длинные rag-ходы: серверный таймаут хода 300 с — клиент не раньше. */
const CHAT_TIMEOUT_MS = 300_000;

export class ChatApiError extends Error {
  constructor(
    readonly code: ChatSseErrorCode,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

export interface SendChatOptions {
  onStep?: (step: string, text: string) => void;
  timeoutMs?: number;
}

function sseLoopError(message: string): ChatApiError {
  return new ChatApiError("upstream_error", 502, message);
}

/** AbortSignal.timeout бросает DOMException TimeoutError с англ. текстом —
 * локализуем (легаси api.ts делал так же; ревью CH-5b, MINOR-6). */
function mapTransportError(err: unknown): unknown {
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "TimeoutError"
  ) {
    return new ChatApiError(
      "upstream_error",
      504,
      "Превышено время ожидания ответа (5 мин) — попробуй ещё раз",
    );
  }
  return err;
}

export async function sendChat(
  request: ChatRequest,
  opts: SendChatOptions = {},
): Promise<ChatResponse> {
  try {
    return await sendChatInner(request, opts);
  } catch (err) {
    throw mapTransportError(err);
  }
}

async function sendChatInner(
  request: ChatRequest,
  opts: SendChatOptions,
): Promise<ChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(opts.timeoutMs ?? CHAT_TIMEOUT_MS),
  });

  if (!res.ok) {
    // До hijack / не-SSE — реальный HTTP-статус (429-ветка клиента).
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    throw new ChatApiError(
      (body.code as ChatSseErrorCode) ?? "upstream_error",
      res.status,
      body.message ?? `HTTP ${res.status}`,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // Теоретическая ветка (прокси снял SSE) — плоский JSON-ответ.
    const parsed = ChatResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw sseLoopError("Ответ не прошёл контракт ответа");
    }
    return parsed.data;
  }

  if (!res.body) {
    throw sseLoopError("Пустой поток ответа");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: ChatResponse | null = null;
  const handleEvent = (raw: string): void => {
    if (!raw.startsWith("data: ")) return;
    const payload = raw.slice("data: ".length);
    if (payload === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return; // битый кадр — пропускаем молча
    }
    const parsed = ChatSseEventSchema.safeParse(event);
    if (!parsed.success) return;
    if (parsed.data.type === "step") {
      opts.onStep?.(parsed.data.step, parsed.data.text);
    } else if (parsed.data.type === "done") {
      done = parsed.data.result;
    } else {
      throw new ChatApiError(
        parsed.data.code,
        parsed.data.httpStatus,
        parsed.data.message,
      );
    }
  };

  try {
    while (true) {
      const { value, done: readerDone } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const part = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          handleEvent(part);
        }
      }
      if (readerDone) break;
    }
  } catch (err) {
    // Бросили посреди потока (error-событие/таймаут) — сокет не тянем:
    // отменяем reader, иначе он живёт до закрытия сервером (MINOR-6).
    try {
      await reader.cancel();
    } catch {
      /* уже закрыт */
    }
    throw err;
  }

  if (!done) {
    throw sseLoopError("Поток оборвался без ответа");
  }
  const checked = ChatResponseSchema.safeParse(done);
  if (!checked.success) {
    throw sseLoopError("Финальный ответ не прошёл контракт");
  }
  return checked.data;
}
