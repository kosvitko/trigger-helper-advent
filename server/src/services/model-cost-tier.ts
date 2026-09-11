/**
 * Daily ask cap applies only to expensive models.
 * Cheap / DeepSeek-comparable: no daily cap (ledger still records cost).
 *
 * Note: ProxyAPI often returns bare ids in usage.model (e.g. `claude-sonnet-4-5-…`
 * without `anthropic/`). Classify by name markers, not only `provider/`.
 */
export function isExpensiveModel(model: string): boolean {
  const m = model.toLowerCase();

  // Direct DeepSeek and ProxyAPI DeepSeek routes
  if (m.includes("deepseek")) return false;

  // Cheap / mid chat
  if (
    m.includes("gpt-4o-mini") ||
    m.includes("gpt-5.6-luna") ||
    m.includes("haiku") ||
    m.includes("flash-lite") ||
    m.includes("flash_lite")
  ) {
    return false;
  }

  // Gemini Flash (non-pro) ≈ cheap/fast tier
  if (m.includes("gemini") && m.includes("flash") && !m.includes("pro")) {
    return false;
  }

  // Known expensive families (bare API ids or provider/model)
  if (
    m.includes("sonnet") ||
    m.includes("opus") ||
    m.includes("claude") ||
    (m.includes("gpt-4o") && !m.includes("mini")) ||
    m.includes("gpt-4-turbo") ||
    m.includes("gpt-4.1") ||
    m.includes("o1") ||
    m.includes("o3") ||
    (m.includes("gemini") && m.includes("pro"))
  ) {
    return true;
  }

  // Other ProxyAPI provider/model ids → treat as expensive
  if (m.includes("/")) return true;

  // Bare DeepSeek-class default (deepseek-chat, deepseek-v4-flash, …)
  return false;
}

/**
 * Conservative fallback: smallest realistic chat window. A wrong-low limit
 * only refuses a request locally (user can compress history); a wrong-high
 * limit spends a request on an API 400.
 */
export const DEFAULT_CONTEXT_LIMIT = 8_192;

/** Ordered markers — first hit wins (broad families before specific ones). */
const CONTEXT_LIMIT_MARKERS: ReadonlyArray<readonly [string, number]> = [
  ["gemini", 1_000_000],
  ["claude", 200_000],
  ["sonnet", 200_000],
  ["opus", 200_000],
  ["gpt-5", 128_000],
  ["gpt-4.1", 128_000],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["deepseek", 128_000],
];

/**
 * Day08: context window per model (tokens) for the pre-flight guard.
 * Verified: DeepSeek V3.2 chat/reasoner = 128K, gpt-4o(-mini) = 128K,
 * Claude = 200K, Gemini 2.5 = 1M. Unknown ids → conservative default.
 */
export function contextLimitForModel(model: string): number {
  const m = model.toLowerCase();
  for (const [marker, limit] of CONTEXT_LIMIT_MARKERS) {
    if (m.includes(marker)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/** Calendar day in Moscow (Advent / Gladkov TZ). */
export function todayMoscowDate(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Europe/Moscow",
  });
}
