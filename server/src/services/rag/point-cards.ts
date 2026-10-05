import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./paths.js";

/**
 * Day22 (design addendum §7.4, решение Кости): «обычный» доступ к базе точек —
 * без эмбеддингов, через обзор и чтение карточек. Один источник правды для
 * (a) апгрейда старых тулов list_points/get_point (mcp-server, day17) и
 * (b) tool-loop baseline-режима day22 (ask-роут снят 04.10, гейт 261004 §7).
 * Карточки — data/points/*.md (renderer: tools/content-pipeline/render_cards.py, D-12).
 */

const POINTS_DIR = path.join(repoRoot, "data", "points");

export interface PointCardOverview {
  slug: string;
  /** data/points/<slug>.md — repo-relative `source` карточки. */
  source: string;
  title: string;
  zones: string[];
}

const ZONE_RU_TO_EN: Record<string, string> = {
  голова: "head",
  рука: "arm",
  плечо: "shoulder",
  другое: "other",
};

function parseZones(text: string): string[] {
  const line = text.split("\n").find((l) => l.startsWith("Зоны отражённой боли (C6):"));
  if (!line) return [];
  const ru = line.slice(line.indexOf(":") + 1);
  return ru
    .split(",")
    .map((z) => z.trim().replace(/\.$/, "").toLowerCase())
    .filter(Boolean)
    .map((z) => ZONE_RU_TO_EN[z] ?? z);
}

function slugToSource(slug: string): string {
  return `data/points/${slug}.md`;
}

export async function listPointCards(zone?: string): Promise<{
  count: number;
  cards: PointCardOverview[];
}> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(POINTS_DIR)).filter((n) => n.toLowerCase().endsWith(".md"));
  } catch {
    return { count: 0, cards: [] };
  }
  names.sort();
  const cards: PointCardOverview[] = [];
  for (const name of names) {
    const slug = name.replace(/\.md$/i, "");
    const text = await fs.readFile(path.join(POINTS_DIR, name), "utf8");
    const title =
      text.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? slug;
    const zones = parseZones(text);
    if (zone && !zones.includes(zone)) continue;
    cards.push({ slug, source: slugToSource(slug), title, zones });
  }
  return { count: cards.length, cards };
}

export async function readPointCard(
  slug: string,
): Promise<{ slug: string; source: string; title: string; text: string } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null; // no path tricks
  const file = path.join(POINTS_DIR, `${slug}.md`);
  try {
    const text = (await fs.readFile(file, "utf8")).replace(/\r\n?/g, "\n").trim();
    const title =
      text.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? slug;
    return { slug, source: slugToSource(slug), title, text };
  } catch {
    return null;
  }
}
