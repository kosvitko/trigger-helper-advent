import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./rag/paths.js";
import {
  FILES_WORKSPACE_REL,
  REPO_GIT_BRANCH_TOOL,
  REPO_LIST_FILES_TOOL,
  REPO_READ_FILE_TOOL,
  REPO_SEARCH_TOOL,
  dispatchRepoTool,
} from "./repo-tools.js";

describe("repo-tools jail", () => {
  it("read_file отклоняет .env", async () => {
    const r = await dispatchRepoTool(REPO_READ_FILE_TOOL, { path: ".env" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/allowlist|запрещён/i);
  });

  it("read_file отклоняет ../.env", async () => {
    const r = await dispatchRepoTool(REPO_READ_FILE_TOOL, { path: "../.env" });
    expect(r.ok).toBe(false);
  });

  it("read_file отклоняет путь вне репо", async () => {
    const r = await dispatchRepoTool(REPO_READ_FILE_TOOL, { path: "../../../../Windows/System32/drivers/etc/hosts" });
    expect(r.ok).toBe(false);
  });

  it("list_files root содержит server или README", async () => {
    const r = await dispatchRepoTool(REPO_LIST_FILES_TOOL, { dir: "." });
    expect(r.ok).toBe(true);
    const lower = r.text.toLowerCase();
    expect(lower.includes("server") || lower.includes("readme")).toBe(true);
  });

  it("git_branch возвращает непустую ветку или skip без git", async () => {
    const r = await dispatchRepoTool(REPO_GIT_BRANCH_TOOL, {});
    if (r.text.includes("git error")) {
      expect(r.ok).toBe(false);
      return;
    }
    expect(r.ok).toBe(true);
    expect(r.text.replace(/^branch:\s*/, "").trim().length).toBeGreaterThan(0);
  });
});

describe("repo-tools Day34: repo_search + workspace", () => {
  it("repo_search находит известный идентификатор в исходниках", async () => {
    const r = await dispatchRepoTool(REPO_SEARCH_TOOL, {
      query: "dispatchRepoTool",
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/repo-tools\.ts:\d+:/);
  });

  it("repo_search без query → ok:false", async () => {
    const r = await dispatchRepoTool(REPO_SEARCH_TOOL, { query: "  " });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/query обязателен/);
  });

  it("repo_search без совпадений → ok:true с нулём", async () => {
    // Строку собираем из частей: литерал в этом файле сам стал бы совпадением.
    const q = ["zzz", "no-such", "identifier", "qqq"].join("-");
    const r = await dispatchRepoTool(REPO_SEARCH_TOOL, { query: q });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/0 совпадений/);
  });

  it("read_file читает артефакт workspace (исключение var/)", async () => {
    const rel = `${FILES_WORKSPACE_REL}/test-read-${Date.now()}.md`;
    const abs = path.join(repoRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "# day34 test\n", "utf8");
    const r = await dispatchRepoTool(REPO_READ_FILE_TOOL, { path: rel });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("# day34 test");
    await fs.rm(abs, { force: true });
  });

  it("read_file вне workspace в var/ по-прежнему запрещён", async () => {
    const r = await dispatchRepoTool(REPO_READ_FILE_TOOL, {
      path: "var/usage-totals.json",
    });
    expect(r.ok).toBe(false);
  });
});
