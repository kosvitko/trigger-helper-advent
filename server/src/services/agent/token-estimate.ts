import type { AgentMessage } from "@trigger-helper/shared";
import { costRubFromUsage } from "../pricing.js";

/**
 * Day08 — token estimation.
 *
 * API usage is the source of truth for what was billed. Estimation is needed
 * where usage cannot answer:
 *  1. the size of the whole thread when only a tail is sent,
 *  2. a pre-flight decision before spending a request,
 *  3. the system / history / user split.
 *
 * Heuristic: Cyrillic ≈ 2.5 chars per token, Latin/code/JSON ≈ 4. Values are
 * approximate by design — the UI shows «оценка» next to the API fact.
 */

/** OpenAI-compatible chat format overhead per message. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

const CYRILLIC = /[\u0400-\u04FF]/;

export type EstimateMessage = { role: string; content: string };

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cyrillic = 0;
  let other = 0;
  for (const ch of text) {
    if (CYRILLIC.test(ch)) cyrillic += 1;
    else other += 1;
  }
  return Math.ceil(cyrillic / 2.5 + other / 4);
}

export function estimateMessageTokens(message: EstimateMessage): number {
  return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateChatTokens(messages: EstimateMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/** Request size split — «сколько стоит системный промпт / история / ввод». */
export type TokenBreakdown = {
  system: number;
  history: number;
  user: number;
  total: number;
  historyMessages: number;
  /** Day10: extract usage when folded into the run estimate. */
  extract?: number;
  /** Day17: tool-schema tokens riding every tools-run request. */
  tools?: number;
};

export function estimateMessagesBreakdown(parts: {
  system: string;
  history: EstimateMessage[];
  user: string;
}): TokenBreakdown {
  const system = estimateTokens(parts.system) + MESSAGE_OVERHEAD_TOKENS;
  const history = parts.history.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0,
  );
  const user = estimateTokens(parts.user) + MESSAGE_OVERHEAD_TOKENS;
  return {
    system,
    history,
    user,
    total: system + history + user,
    historyMessages: parts.history.length,
  };
}

/** Whole-thread stats: estimation over all messages + actual usage facts. */
export type ThreadTokens = {
  count: number;
  tokensEstimate: number;
  /** Sum of usage.total_tokens from assistant messages (API fact). */
  tokensActualSum: number;
  costRubSum: number;
  /** Day08: total tokens saved by compressions in this thread. */
  savedTokensSum: number;
};

export function sumThreadTokens(messages: AgentMessage[]): ThreadTokens {
  let tokensEstimate = 0;
  let tokensActualSum = 0;
  let costRubSum = 0;
  let savedTokensSum = 0;

  for (const m of messages) {
    tokensEstimate += estimateMessageTokens(m);
    if (m.usage) {
      tokensActualSum += m.usage.total_tokens;
    }
    costRubSum += messageCostRub(m);
    savedTokensSum += m.saved_tokens ?? 0;
  }

  return {
    count: messages.length,
    tokensEstimate,
    tokensActualSum,
    costRubSum: Number(costRubSum.toFixed(4)),
    savedTokensSum,
  };
}

/** Billed ₽ for one message: stored display value, else derived from usage. */
export function messageCostRub(message: AgentMessage): number {
  if (message.cost_rub !== undefined) return message.cost_rub;
  return message.usage ? costRubFromUsage(message.usage) : 0;
}
