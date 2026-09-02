import {
  CompareRequestSchema,
  ReasoningModeSchema,
  type CompareResponse,
  type ReasoningMode,
} from "@trigger-helper/shared";
import type { FastifyInstance } from "fastify";
import type { DeepSeekService } from "../services/deepseek.js";
import type { UsageLedgerService } from "../services/usage-ledger.js";
import {
  JUDGE_CRITERIA,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
} from "../services/prompt.js";

type CompareRouteDeps = {
  deepSeekService: DeepSeekService;
  usageLedger: UsageLedgerService;
};

const JUDGE_MAX_TOKENS = 1200;

type RawJudgeJson = {
  scores?: Array<{
    mode?: string;
    criteria?: Array<{ id?: string; pass?: boolean }>;
    passed?: number;
    total?: number;
  }>;
  winner?: string | null;
  rationale?: string;
};

function parseJudgeJson(text: string): RawJudgeJson {
  try {
    return JSON.parse(text) as RawJudgeJson;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1)) as RawJudgeJson;
    }
    throw new Error("Judge returned non-JSON");
  }
}

function normalizeCompareResponse(
  raw: RawJudgeJson,
  modes: ReasoningMode[],
  scenario: "N" | "P",
  usage: CompareResponse["usage"],
): CompareResponse {
  const expected = JUDGE_CRITERIA[scenario];
  const byMode = new Map(
    (raw.scores ?? []).map((s) => [s.mode, s] as const),
  );

  const scores = modes.map((mode) => {
    const row = byMode.get(mode);
    const criteria = expected.map((c) => {
      const found = row?.criteria?.find((x) => x.id === c.id);
      return { id: c.id, pass: Boolean(found?.pass) };
    });
    const passed = criteria.filter((c) => c.pass).length;
    return {
      mode,
      criteria,
      passed,
      total: expected.length,
    };
  });

  let winner: ReasoningMode | null = null;
  const winnerRaw = raw.winner;
  if (winnerRaw && ReasoningModeSchema.safeParse(winnerRaw).success) {
    const candidate = winnerRaw as ReasoningMode;
    const row = scores.find((s) => s.mode === candidate);
    if (row) {
      const e1 = row.criteria.find((c) => c.id === "E1");
      if (scenario === "P" && e1 && !e1.pass) {
        winner = null;
      } else {
        winner = candidate;
      }
    }
  }

  if (!winner) {
    const eligible =
      scenario === "P"
        ? scores.filter((s) => s.criteria.find((c) => c.id === "E1")?.pass)
        : scores;
    const best = Math.max(0, ...eligible.map((s) => s.passed));
    const top = eligible.filter((s) => s.passed === best && best > 0);
    winner = top.length === 1 ? top[0]!.mode : null;
  }

  return {
    scores,
    winner,
    rationale: (raw.rationale ?? "").trim() || "Вердикт без rationale от модели.",
    usage,
  };
}

export async function registerCompareRoutes(
  app: FastifyInstance,
  deps: CompareRouteDeps,
): Promise<void> {
  app.post("/api/compare", async (request, reply) => {
    const parsed = CompareRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }

    const { scenario, question, candidates } = parsed.data;
    const modes = candidates.map((c) => c.mode);

    try {
      const result = await deps.deepSeekService.chat(
        [
          { role: "system", content: buildJudgeSystemPrompt(scenario) },
          {
            role: "user",
            content: buildJudgeUserPrompt({ scenario, question, candidates }),
          },
        ],
        {
          jsonMode: true,
          maxTokens: JUDGE_MAX_TOKENS,
          temperature: 0.2,
        },
      );

      const raw = parseJudgeJson(result.reply);
      const body = normalizeCompareResponse(
        raw,
        modes,
        scenario,
        result.usage,
      );
      body.totals = await deps.usageLedger.record(result.usage);
      return body;
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: "Compare (judge) failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}
