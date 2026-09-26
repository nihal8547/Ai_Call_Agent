import type { FastifyRequest } from "fastify";

export function requestMeta(req: FastifyRequest): { ip: string; userAgent?: string } {
  const ua = req.headers["user-agent"];
  return { ip: req.ip, ...(ua ? { userAgent: ua } : {}) };
}
