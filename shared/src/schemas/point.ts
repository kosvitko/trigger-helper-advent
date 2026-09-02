import { z } from "zod";

export const PointSchema = z.object({
  id: z.string(),
  name: z.string(),
  pain_zones: z.array(z.string()),
  technique: z.string(),
  cautions: z.string(),
});

export type Point = z.infer<typeof PointSchema>;

export const PointsFileSchema = z.object({
  points: z.array(PointSchema),
});

export type PointsFile = z.infer<typeof PointsFileSchema>;
