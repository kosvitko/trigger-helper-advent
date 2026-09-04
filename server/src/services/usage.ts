import type { LlmUsage } from "@trigger-helper/shared";

/** Sum usage across multi-call flows (meta, etc.). */
export function mergeUsage(parts: LlmUsage[]): LlmUsage {
  if (parts.length === 0) {
    throw new Error("mergeUsage requires at least one usage");
  }
  if (parts.length === 1) {
    return parts[0]!;
  }

  const model = parts[parts.length - 1]!.model;
  let prompt_tokens = 0;
  let completion_tokens = 0;
  let total_tokens = 0;
  let prompt_cache_hit_tokens = 0;
  let prompt_cache_miss_tokens = 0;
  let estimated_cost_usd = 0;
  let estimated_cost_rub = 0;

  for (const u of parts) {
    prompt_tokens += u.prompt_tokens;
    completion_tokens += u.completion_tokens;
    total_tokens += u.total_tokens;
    prompt_cache_hit_tokens += u.prompt_cache_hit_tokens;
    prompt_cache_miss_tokens += u.prompt_cache_miss_tokens;
    estimated_cost_usd += u.estimated_cost_usd;
    estimated_cost_rub += u.estimated_cost_rub ?? 0;
  }

  return {
    model,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    prompt_cache_hit_tokens,
    prompt_cache_miss_tokens,
    estimated_cost_usd: Number(estimated_cost_usd.toFixed(6)),
    estimated_cost_rub: Number(estimated_cost_rub.toFixed(4)),
  };
}
