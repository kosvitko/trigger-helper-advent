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

/** Calendar day in Moscow (Advent / Gladkov TZ). */
export function todayMoscowDate(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Europe/Moscow",
  });
}
