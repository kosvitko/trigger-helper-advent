import { describe, expect, it } from "vitest";
import {
  REPO_GIT_BRANCH_TOOL,
  REPO_LIST_FILES_TOOL,
  REPO_READ_FILE_TOOL,
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
