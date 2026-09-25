import fs from "node:fs";
import { createHash } from "node:crypto";
import { listMcpTools } from "./mcp-client.js";
import { OWN_MCP_TOOL_SCHEMAS, ownMcpUrl } from "./mcp-server.js";

/**
 * Day20: registry of MCP servers for agent orchestration.
 *
 * Own server ("own") is always present — its specs come from the static
 * OWN_MCP_TOOL_SCHEMAS import (02b MAJOR-2: no HTTP self-listing, the loopback
 * route is not even listening at boot time). External servers come from
 * MCP_SERVERS="name=url,…" and are listed at boot (per-call lifecycle —
 * stateless servers, the listing cache is write-once by design).
 *
 * Fail-closed semantics (design §3.3):
 *  - a server without an MCP_INJECT_<NAME> key injects NOTHING into the LLM
 *    (boot warning; visible in UI as injectCount 0);
 *  - baseline hash mismatch / missing file / listing failure → the server is
 *    degraded: listed in the UI, never injected, agent runs continue on own
 *    tools (day17 contract);
 *  - only config errors are fatal: invalid MCP_SERVERS syntax and wire-name
 *    collisions fail the boot loudly (12-factor: broken config must not boot).
 */

/** Neutral flat spec — no deepseek / MCP-SDK types leak into this module. */
export type RegisteredToolSpec = {
  /** Wire name the LLM sees: own tools as-is, external `<server>_<native>`. */
  name: string;
  description: string;
  parameters: unknown;
};

export type RegisteredServerSnapshot = {
  name: string;
  url: string;
  ok: boolean;
  degradedReason?: string;
  serverInfo: { name: string; version: string };
  toolCount: number;
  tools: { name: string; description: string; inputSchema: unknown }[];
  /** Native tool names injected into the LLM (fail-closed filter, D-3). */
  injectNames: string[];
  injectCount: number;
};

export type McpRegistry = {
  /** Own specs first (canon order), then injected external tools. */
  getToolSpecs(): RegisteredToolSpec[];
  /** Wire name → call target; undefined = model hallucinated a tool. */
  resolve(
    wireName: string,
  ): { url: string; nativeName: string; serverName: string } | undefined;
  snapshot(): { servers: RegisteredServerSnapshot[] };
};

/** Wire shape for the LLM `tools` param — the single flat→wrapped transform. */
export function toWireToolSpecs(specs: RegisteredToolSpec[]) {
  return specs.map((spec) => ({
    type: "function" as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  }));
}

const SERVER_NAME_RE = /^[a-z0-9]+$/;

function parseMcpServers(raw: string): { name: string; url: string }[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) {
        throw new Error(`Invalid MCP_SERVERS entry "${part}" (ожидается name=url)`);
      }
      const name = part.slice(0, eq).trim();
      const url = part.slice(eq + 1).trim();
      if (!SERVER_NAME_RE.test(name)) {
        throw new Error(
          `Invalid MCP_SERVERS name "${name}" — ожидается [a-z0-9]+ (ключ фильтра: MCP_INJECT_${name.toUpperCase()})`,
        );
      }
      try {
        // Validate URL shape early; the actual host is only contacted below.
        new URL(url);
      } catch {
        throw new Error(`Invalid MCP_SERVERS url for "${name}": "${url}"`);
      }
      return { name, url };
    });
}

/** Fail-closed filter (D-3): missing key → ∅; empty after trim → ∅ (explicit). */
function readInjectFilter(serverName: string): {
  missing: boolean;
  names: string[];
} {
  const key = `MCP_INJECT_${serverName.toUpperCase()}`;
  const raw = process.env[key];
  if (raw === undefined) return { missing: true, names: [] };
  return { missing: false, names: raw.split(",").map((n) => n.trim()).filter(Boolean) };
}

/**
 * Canonical JSON: object keys sorted recursively — hashes must not depend on
 * key order (the SDK zod-parse reorders schema keys vs raw JSON.parse;
 * pass 05 M-1 lesson from the first local smoke).
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toolHash(tool: { description: string; inputSchema: unknown }): string {
  return createHash("sha256")
    .update(canonicalJson({ description: tool.description, inputSchema: tool.inputSchema }))
    .digest("hex");
}

type Baseline = Record<string, Record<string, string>>;

/** Broken/missing baseline file → {} (every external degrades), boot survives. */
function readBaseline(): Baseline {
  try {
    const raw = fs.readFileSync(
      new URL("./mcp-registry.baseline.json", import.meta.url),
      "utf8",
    );
    return JSON.parse(raw) as Baseline;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mcp-registry] baseline недоступен (${message}) — внешние серверы стартуют degraded`);
    return {};
  }
}

/** null = ok; string = human-readable degradation reason (fail-closed, D-4). */
function checkBaselineDiff(
  baseline: Baseline,
  serverName: string,
  tools: { name: string; description: string; inputSchema: unknown }[],
): string | null {
  const expected = baseline[serverName];
  if (!expected) return "нет baseline-снапшота для сервера";
  const actual = new Map(tools.map((t) => [t.name, toolHash(t)]));
  for (const [name, hash] of actual) {
    if (expected[name] !== hash) return `baseline mismatch: ${name}`;
  }
  for (const name of Object.keys(expected)) {
    if (!actual.has(name)) return `тулза исчезла из листинга: ${name}`;
  }
  return null;
}

interface ServerRecord {
  name: string;
  url: string;
  ok: boolean;
  degradedReason?: string;
  serverInfo: { name: string; version: string };
  tools: { name: string; description: string; inputSchema: unknown }[];
  /** wire → native, only for injected tools of ok servers. */
  inject: Map<string, string>;
}

export async function createMcpRegistry(opts: {
  port: number;
}): Promise<McpRegistry> {
  const servers: ServerRecord[] = [];
  const wireIndex = new Map<
    string,
    { url: string; nativeName: string; serverName: string }
  >();

  // --- own server: static specs, no HTTP self-listing (02b MAJOR-2). ---
  // serverInfo mirrors createOwnMcpServer() in mcp-server.ts (kept in sync by
  // convention — mcp-server.ts is canon and stays untouched).
  const own: ServerRecord = {
    name: "own",
    url: ownMcpUrl(opts.port),
    ok: true,
    serverInfo: { name: "trigger-helper-atlas", version: "0.1.0" },
    tools: OWN_MCP_TOOL_SCHEMAS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
    inject: new Map(
      OWN_MCP_TOOL_SCHEMAS.map((tool) => [
        tool.name,
        tool.name,
      ]) as [string, string][],
    ),
  };
  servers.push(own);
  for (const tool of own.tools) {
    wireIndex.set(tool.name, { url: own.url, nativeName: tool.name, serverName: "own" });
  }

  // --- external servers: env-driven, listed at boot, baseline-checked. ---
  const rawServers = process.env.MCP_SERVERS?.trim();
  const externals = rawServers ? parseMcpServers(rawServers) : [];
  const baseline = readBaseline();

  await Promise.all(
    externals.map(async (ext) => {
      const record: ServerRecord = {
        name: ext.name,
        url: ext.url,
        ok: false,
        serverInfo: { name: ext.name, version: "?" },
        tools: [],
        inject: new Map(),
      };
      try {
        // Day20: one boot retry — a transient CF/NCBI timeout must not degrade
        // the server for the whole process lifetime (screencast risk).
        let listing = await listMcpTools(ext.url).catch(() => null);
        if (!listing) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          listing = await listMcpTools(ext.url);
        }
        record.serverInfo = listing.serverInfo;
        record.tools = listing.tools;

        const diff = checkBaselineDiff(baseline, ext.name, listing.tools);
        if (diff) {
          record.degradedReason = diff;
          servers.push(record);
          return;
        }

        const filter = readInjectFilter(ext.name);
        if (filter.missing) {
          console.warn(
            `[mcp-registry] ${ext.name}: нет ключа MCP_INJECT_${ext.name.toUpperCase()} — в LLM не инжектится (fail-closed)`,
          );
        }
        const listed = new Set(listing.tools.map((t) => t.name));
        const unknown = filter.names.filter((native) => !listed.has(native));
        if (unknown.length > 0) {
          record.degradedReason = `MCP_INJECT_${ext.name.toUpperCase()}: нет в листинге — ${unknown.join(", ")}`;
          servers.push(record);
          return;
        }
        for (const native of filter.names) {
          const wire = `${ext.name}_${native}`;
          if (wireIndex.has(wire)) {
            // Fail-fast (D-2): broken config must not boot half-configured.
            throw new Error(`MCP tool name collision on boot: "${wire}"`);
          }
          wireIndex.set(wire, { url: ext.url, nativeName: native, serverName: ext.name });
          record.inject.set(wire, native);
        }
        record.ok = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Collision throws are config errors — re-throw to fail the boot.
        if (message.includes("collision")) throw error;
        record.degradedReason = message;
      }
      servers.push(record);
    }),
  );

  for (const record of servers) {
    console.log(
      `[mcp-registry] ${record.name}: ${
        record.ok ? `ok, inject ${record.inject.size}` : `degraded (${record.degradedReason})`
      }`,
    );
  }

  return {
    getToolSpecs(): RegisteredToolSpec[] {
      const specs: RegisteredToolSpec[] = own.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
      for (const record of servers) {
        if (record.name === "own" || !record.ok) continue;
        for (const [wire, native] of record.inject) {
          const tool = record.tools.find((t) => t.name === native);
          if (!tool) continue; // unreachable: inject names validated at boot
          specs.push({
            name: wire,
            description: `${tool.description} Внешний источник научных публикаций (${record.name}). Используй, когда задача требует связанных статей, полных текстов, MeSH-словаря или оформления ссылок; для атласа точек и собственного поиска/сводки продукта используй внутренние инструменты.`,
            parameters: tool.inputSchema,
          });
        }
      }
      return specs;
    },

    resolve(wireName) {
      return wireIndex.get(wireName);
    },

    snapshot() {
      return {
        servers: servers.map((record) => ({
          name: record.name,
          url: record.url,
          ok: record.ok,
          ...(record.degradedReason ? { degradedReason: record.degradedReason } : {}),
          serverInfo: { ...record.serverInfo },
          toolCount: record.tools.length,
          tools: record.tools.map((tool) => ({ ...tool })),
          injectNames: [...record.inject.values()],
          injectCount: record.inject.size,
        })),
      };
    },
  };
}
