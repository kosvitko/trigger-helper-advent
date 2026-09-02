import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PointsFileSchema, type Point } from "@trigger-helper/shared";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function resolveDataDir(customDir?: string): string {
  return customDir ? path.resolve(customDir) : path.join(repoRoot, "data");
}

export class PointsService {
  private cache: Point[] | null = null;

  constructor(private readonly dataDir: string) {}

  async loadAll(): Promise<Point[]> {
    if (this.cache) {
      return this.cache;
    }

    const filePath = path.join(this.dataDir, "points.json");
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = PointsFileSchema.parse(JSON.parse(raw));
    this.cache = parsed.points;
    return this.cache;
  }

  async findById(id: string): Promise<Point | undefined> {
    const points = await this.loadAll();
    return points.find((point) => point.id === id);
  }
}

export function createPointsService(dataDir?: string): PointsService {
  return new PointsService(resolveDataDir(dataDir));
}
