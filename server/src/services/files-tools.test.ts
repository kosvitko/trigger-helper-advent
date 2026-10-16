import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./rag/paths.js";
import { FILES_WORKSPACE_REL } from "./repo-tools.js";
import { FILES_WRITE_TOOL, dispatchFilesTool, filesRailWantsArtifact } from "./files-tools.js";

const ws = path.join(repoRoot, ...FILES_WORKSPACE_REL.split("/"));

describe("files-tools Day34: jail + diff", () => {
  it("новый файл: ok, «new file», контент на диске", async () => {
    const rel = `smoke-${Date.now()}.md`;
    const r = await dispatchFilesTool(FILES_WRITE_TOOL, {
      path: rel,
      content: "# Заголовок\nстрока",
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("new file");
    expect(r.text).toContain("+строка");
    const onDisk = await fs.readFile(path.join(ws, rel), "utf8");
    expect(onDisk).toBe("# Заголовок\nстрока");
    await fs.rm(path.join(ws, rel), { force: true });
  });

  it("перезапись: unified diff с @@ и -/+ строками", async () => {
    const rel = `smoke2-${Date.now()}.md`;
    await dispatchFilesTool(FILES_WRITE_TOOL, {
      path: rel,
      content: "a\nb\nc",
    });
    const r = await dispatchFilesTool(FILES_WRITE_TOOL, {
      path: rel,
      content: "a\nB\nc",
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/@@ -\d+(,\d+)? \+\d+(,\d+)? @@/);
    expect(r.text).toContain("-b");
    expect(r.text).toContain("+B");
    await fs.rm(path.join(ws, rel), { force: true });
  });

  it("jail: .. в пути запрещён", async () => {
    const r = await dispatchFilesTool(FILES_WRITE_TOOL, {
      path: "../escape.md",
      content: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/вне workspace/);
  });

  it("jail: абсолютный путь запрещён", async () => {
    const r = await dispatchFilesTool(FILES_WRITE_TOOL, {
      path: "/etc/x.md",
      content: "x",
    });
    expect(r.ok).toBe(false);
  });

  it("расширение: только .md/.json", async () => {
    const r = await dispatchFilesTool(FILES_WRITE_TOOL, {
      path: "script.ts",
      content: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/\.md или \.json/);
  });

  it("content обязателен и ограничен 16k симв", async () => {
    const empty = await dispatchFilesTool(FILES_WRITE_TOOL, {
      path: "x.md",
      content: "",
    });
    expect(empty.ok).toBe(false);
    const big = await dispatchFilesTool(FILES_WRITE_TOOL, {
      path: "x.md",
      content: "x".repeat(16_001),
    });
    expect(big.ok).toBe(false);
  });

  it("неизвестная тулза → ok:false", async () => {
    const r = await dispatchFilesTool("files_x", {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/unknown files tool/);
  });
});

describe("files-rail: естественные реплики (cust-fix 15.10)", () => {
  it("просьбу артефакта узнаёт без имён тулзов и файлов", () => {
    expect(filesRailWantsArtifact("Оформи это справочником и сохрани.")).toBe(true);
    expect(filesRailWantsArtifact("Добавь туда информацию про jail и allowlist.")).toBe(true);
    expect(filesRailWantsArtifact("Пересобери справочник начисто.")).toBe(true);
    expect(filesRailWantsArtifact("найди все места вызова и сохрани справочник")).toBe(true);
  });

  it("чистый поиск и чтение запись не требуют", () => {
    expect(
      filesRailWantsArtifact(
        "Собираюсь рефакторить тулзы репозитория. Найди, где используется dispatchRepoTool.",
      ),
    ).toBe(false);
    expect(filesRailWantsArtifact("Покажи, что записано в файле")).toBe(false);
    expect(filesRailWantsArtifact("что такое атлас триггерных точек?")).toBe(false);
  });
});
