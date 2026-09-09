import type {
  AgentInstance,
  AgentMessage,
  LlmUsage,
} from "@trigger-helper/shared";
import type { ChatMessage, DeepSeekService } from "../deepseek.js";
import { costRubFromUsage } from "../pricing.js";
import { buildSystemPrompt } from "./presets.js";

const HISTORY_TAIL = 10;
const AGENT_MAX_TOKENS = 1_200;

export type AgentRunOverrides = {
  model?: string;
  temperature?: number;
};

export type AgentRunOk = {
  reply: string;
  usage: LlmUsage;
  latency_ms: number;
  model: string;
  temperature: number;
  cost_rub: number;
  overridesApplied: { model: boolean; temperature: boolean };
};

export class AgentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPolicyError";
  }
}

function applyInputPolicy(agent: AgentInstance, raw: string): string {
  const policy = agent.inputPolicy;
  let text = policy.trim ? raw.trim() : raw;
  if (policy.requireNonEmpty && !text) {
    throw new AgentPolicyError("Пустой ввод");
  }
  if (text.length > policy.maxChars) {
    text = text.slice(0, policy.maxChars);
  }
  return text;
}

function applyOutputPolicy(agent: AgentInstance, reply: string): string {
  const policy = agent.outputPolicy;
  let text = policy.trim ? reply.trim() : reply;
  if (policy.maxChars && text.length > policy.maxChars) {
    text = `${text.slice(0, policy.maxChars - 1)}…`;
  }
  return text;
}

function historyToChat(messages: AgentMessage[]): ChatMessage[] {
  const tail = messages.slice(-HISTORY_TAIL);
  const out: ChatMessage[] = [];
  for (const m of tail) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/**
 * LlmAgent — entity for day06 (name avoids clash with undici.Agent).
 * Owns config + light I/O policies + 3 context layers + run().
 */
export class LlmAgent {
  constructor(
    private readonly deepSeek: DeepSeekService,
    private readonly defaultModel: string,
  ) {}

  async run(
    agent: AgentInstance,
    rawInput: string,
    history: AgentMessage[],
    overrides: AgentRunOverrides = {},
  ): Promise<AgentRunOk> {
    const input = applyInputPolicy(agent, rawInput);
    const model = overrides.model ?? agent.defaultModel ?? this.defaultModel;
    const temperature =
      overrides.temperature ?? agent.defaultTemperature ?? 0.7;

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(agent) },
      ...historyToChat(history),
      { role: "user", content: input },
    ];

    const result = await this.deepSeek.chat(messages, {
      maxTokens: AGENT_MAX_TOKENS,
      temperature,
      model,
    });

    const reply = applyOutputPolicy(agent, result.reply);
    return {
      reply,
      usage: result.usage,
      latency_ms: result.latency_ms,
      model: result.usage.model,
      temperature,
      cost_rub: costRubFromUsage(result.usage),
      overridesApplied: {
        model: Boolean(overrides.model),
        temperature: overrides.temperature !== undefined,
      },
    };
  }
}

export function createLlmAgent(
  deepSeek: DeepSeekService,
  defaultModel: string,
): LlmAgent {
  return new LlmAgent(deepSeek, defaultModel);
}
