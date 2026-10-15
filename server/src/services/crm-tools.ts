import fs from "node:fs";
import path from "node:path";
import type { ToolSpec } from "./deepseek.js";
import { repoRoot } from "./rag/paths.js";

/**
 * Day33 (гейт 261014, Pick A): in-process CRM tools — read-only тикет-стор
 * поддержки над data/support/{users,tickets}.json. Паттерн repo-tools дня 31:
 * ToolSpec + dispatch, без внешнего процесса (MCP-эквивалент in-process).
 */

export const CRM_GET_TICKET_TOOL = "crm_get_ticket";
export const CRM_GET_USER_TOOL = "crm_get_user";
export const CRM_LIST_TICKETS_TOOL = "crm_list_tickets";

const CLIP_CHAR_CAP = 4_000;
const LIST_CAP = 20;

export type CrmUser = {
  id: number;
  name: string;
  email: string;
  plan: "free" | "pro";
  createdAt: string;
};

export type CrmTicketContext = {
  plan: string;
  asksUsedToday?: number;
  dailyLimit?: number;
  errorCode?: number;
  modelTier?: string;
};

export type CrmTicketMessage = {
  from: "user" | "support";
  at: string;
  text: string;
};

export type CrmTicket = {
  id: number;
  userId: number;
  subject: string;
  status: "open" | "pending" | "resolved";
  createdAt: string;
  context: CrmTicketContext;
  messages: CrmTicketMessage[];
};

export type CrmStore = {
  /** null — данные загружены; строка — причина fail-closed (dispatch → ok:false). */
  loadError: string | null;
  getTicket(id: number): CrmTicket | undefined;
  getUser(id?: number, email?: string): CrmUser | undefined;
  listTickets(filter: { status?: string; userId?: number }): CrmTicket[];
};

export type CrmToolDispatchResult = {
  ok: boolean;
  text: string;
  clip: string;
};

function clipText(text: string, max = CLIP_CHAR_CAP): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fail(text: string): CrmToolDispatchResult {
  return { ok: false, text, clip: clipText(text) };
}

function okResult(text: string): CrmToolDispatchResult {
  return { ok: true, text, clip: clipText(text) };
}

function userLabel(u: CrmUser): string {
  return `u${u.id} ${u.name} (${u.plan})`;
}

function isUser(v: unknown): v is CrmUser {
  if (!v || typeof v !== "object") return false;
  const u = v as Record<string, unknown>;
  return (
    typeof u.id === "number" &&
    Number.isFinite(u.id) &&
    typeof u.name === "string" &&
    typeof u.email === "string" &&
    (u.plan === "free" || u.plan === "pro") &&
    typeof u.createdAt === "string"
  );
}

function isTicketMessage(v: unknown): v is CrmTicketMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    (m.from === "user" || m.from === "support") &&
    typeof m.at === "string" &&
    typeof m.text === "string"
  );
}

function isTicket(v: unknown): v is CrmTicket {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === "number" &&
    Number.isFinite(t.id) &&
    typeof t.userId === "number" &&
    typeof t.subject === "string" &&
    (t.status === "open" || t.status === "pending" || t.status === "resolved") &&
    typeof t.createdAt === "string" &&
    !!t.context &&
    typeof t.context === "object" &&
    Array.isArray(t.messages) &&
    t.messages.every(isTicketMessage)
  );
}

const emptyStore = (loadError: string): CrmStore => ({
  loadError,
  getTicket: () => undefined,
  getUser: () => undefined,
  listTickets: () => [],
});

/** Читает data/support/*.json один раз при создании (sync — фабрика без await
 * в index.ts); битое/отсутствующее хранилище → fail-closed, без throw. */
export function createCrmStore(dataDir?: string): CrmStore {
  const dir = dataDir ?? path.join(repoRoot, "data", "support");
  let usersRaw: string;
  let ticketsRaw: string;
  try {
    usersRaw = fs.readFileSync(path.join(dir, "users.json"), "utf8");
    ticketsRaw = fs.readFileSync(path.join(dir, "tickets.json"), "utf8");
  } catch {
    return emptyStore("crm: хранилище обращений недоступно (data/support/users.json|tickets.json)");
  }
  let users: unknown;
  let tickets: unknown;
  try {
    users = JSON.parse(usersRaw);
    tickets = JSON.parse(ticketsRaw);
  } catch {
    return emptyStore("crm: данные обращений повреждены (битый JSON)");
  }
  if (!Array.isArray(users) || !users.every(isUser)) {
    return emptyStore("crm: users.json не проходит проверку формы");
  }
  if (!Array.isArray(tickets) || !tickets.every(isTicket)) {
    return emptyStore("crm: tickets.json не проходит проверку формы");
  }
  const usersList = users as CrmUser[];
  const ticketsList = tickets as CrmTicket[];
  return {
    loadError: null,
    getTicket: (id) => ticketsList.find((t) => t.id === id),
    getUser: (id, email) =>
      (id !== undefined ? usersList.find((u) => u.id === id) : undefined) ??
      (email !== undefined
        ? usersList.find((u) => u.email.toLowerCase() === email.toLowerCase())
        : undefined),
    listTickets: (filter) =>
      ticketsList
        .filter((t) => (filter.status ? t.status === filter.status : true))
        .filter((t) => (filter.userId !== undefined ? t.userId === filter.userId : true))
        .sort((a, b) => a.id - b.id),
  };
}

export function buildCrmGetTicketToolSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: CRM_GET_TICKET_TOOL,
      description:
        "Получить обращение (тикет) поддержки по номеру: тема, статус, контекст пользователя " +
        "(план, использованные ходы, код ошибки), история сообщений.",
      parameters: {
        type: "object",
        properties: {
          ticketId: {
            type: "number",
            description: "Номер тикета, например 17.",
          },
        },
        required: ["ticketId"],
      },
    },
  };
}

export function buildCrmGetUserToolSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: CRM_GET_USER_TOOL,
      description:
        "Найти пользователя поддержки по id или email: имя, тариф (free/pro), дата начала, его обращения.",
      parameters: {
        type: "object",
        properties: {
          userId: {
            type: "number",
            description: "Числовой id пользователя, например 1001.",
          },
          email: {
            type: "string",
            description: "Email пользователя.",
          },
        },
      },
    },
  };
}

export function buildCrmListTicketsToolSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: CRM_LIST_TICKETS_TOOL,
      description:
        "Список обращений поддержки (до 20): номер, тема, статус, пользователь, дата. " +
        "Фильтры по статусу (open/pending/resolved) и id пользователя.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Статус: open, pending или resolved.",
          },
          userId: {
            type: "number",
            description: "Только обращения этого пользователя.",
          },
        },
      },
    },
  };
}

export function buildCrmToolSpecs(): ToolSpec[] {
  return [
    buildCrmGetTicketToolSpec(),
    buildCrmGetUserToolSpec(),
    buildCrmListTicketsToolSpec(),
  ];
}

function ticketContextText(t: CrmTicket): string {
  const parts: string[] = [`план ${t.context.plan}`];
  if (t.context.asksUsedToday !== undefined || t.context.dailyLimit !== undefined) {
    parts.push(`использовано ходов сегодня: ${t.context.asksUsedToday ?? "?"} из ${t.context.dailyLimit ?? "?"}`);
  }
  if (t.context.errorCode !== undefined) parts.push(`код ошибки: ${t.context.errorCode}`);
  if (typeof t.context.modelTier === "string") parts.push(`тир модели: ${t.context.modelTier}`);
  return parts.join(" · ");
}

function renderTicket(t: CrmTicket, user: CrmUser | undefined): string {
  const lines: string[] = [
    `тикет #${t.id} · ${t.status} · ${user ? userLabel(user) : `userId:${t.userId}`} · создан ${t.createdAt}`,
    `тема: ${t.subject}`,
    `контекст: ${ticketContextText(t)}`,
  ];
  if (user) lines.push(`пользователь: ${user.name} · ${user.email} · с ${user.createdAt}`);
  lines.push("сообщения:");
  for (const m of t.messages) lines.push(`[${m.at}] ${m.from}: ${m.text}`);
  return lines.join("\n");
}

export async function dispatchCrmTool(
  name: string,
  args: Record<string, unknown>,
  store: CrmStore,
): Promise<CrmToolDispatchResult> {
  if (store.loadError !== null) return fail(store.loadError);
  switch (name) {
    case CRM_GET_TICKET_TOOL: {
      const id = args.ticketId;
      if (typeof id !== "number" || !Number.isFinite(id)) {
        return fail("crm_get_ticket: ticketId (число) обязателен");
      }
      const ticket = store.getTicket(id);
      if (!ticket) return fail(`тикет #${id} не найден`);
      return okResult(renderTicket(ticket, store.getUser(ticket.userId)));
    }
    case CRM_GET_USER_TOOL: {
      const hasId = typeof args.userId === "number" && Number.isFinite(args.userId);
      const hasEmail = typeof args.email === "string" && args.email.trim().length > 0;
      if (!hasId && !hasEmail) {
        return fail("crm_get_user: нужен userId (число) или email (строка)");
      }
      const user = store.getUser(
        hasId ? (args.userId as number) : undefined,
        hasEmail ? (args.email as string).trim() : undefined,
      );
      if (!user) {
        return fail(`пользователь не найден (${hasId ? `userId ${String(args.userId)}` : String(args.email)})`);
      }
      const tickets = store.listTickets({ userId: user.id });
      const lines = [
        `${userLabel(user)} · ${user.email} · с ${user.createdAt}`,
        `обращений: ${tickets.length}` +
          (tickets.length > 0
            ? ` (${tickets.map((t) => `#${t.id} ${t.status}`).join(", ")})`
            : ""),
      ];
      return okResult(lines.join("\n"));
    }
    case CRM_LIST_TICKETS_TOOL: {
      const status = typeof args.status === "string" ? args.status.trim() : undefined;
      const userId =
        typeof args.userId === "number" && Number.isFinite(args.userId) ? args.userId : undefined;
      const all = store.listTickets({ status, userId });
      if (all.length === 0) return okResult("обращений не найдено");
      const shown = all.slice(0, LIST_CAP);
      const lines = [
        `тикетов: ${all.length}${all.length > shown.length ? ` (показано ${shown.length})` : ""}`,
      ];
      for (const t of shown) {
        lines.push(`#${t.id} · ${t.subject} · ${t.status} · userId:${t.userId} · ${t.createdAt}`);
      }
      return okResult(lines.join("\n"));
    }
    default:
      return fail(`unknown crm tool: ${name}`);
  }
}
