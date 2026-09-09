import type { FastifyInstance } from "fastify";

function clientIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    status: "ok",
    service: "trigger-helper",
  }));

  /** Client IP as seen by server (after trustProxy / X-Forwarded-For). */
  app.get("/api/whoami", async (request) => ({
    ip: clientIp(request.ip),
  }));
}
