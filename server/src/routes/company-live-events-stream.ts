import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { completeIdleReadOnlyResponse } from "../middleware/idle-admission.js";
import { createCompanyLiveDelivery, type CompanyLiveContext, type CompanyLiveSink } from "../realtime/company-live-delivery.js";

/** Same HTTP authentication and viewer filtering as the ordinary board, with no URL credentials. */
export function createCompanyLiveEventStreams(db: Db, options: {
  subscribe?: (companyId: string, listener: Parameters<typeof subscribeCompanyLiveEvents>[1]) => () => void;
  keepaliveMs?: number;
} = {}) {
  const router = Router();
  const connections = new Set<() => void>();
  let closed = false;
  router.get("/companies/:companyId/events/stream", (req: Request, res: Response) => {
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    if (req.aborted || res.destroyed || res.writableEnded) {
      completeIdleReadOnlyResponse(req, req.app);
      return;
    }
    if (closed) { res.status(503).json({ error: "server_draining" }); return; }
    // WebSocket accepts full agent API keys, not restricted connection/test keys or run JWTs.
    if (req.actor.type === "agent" && (req.actor.source !== "agent_key" || req.actor.keyScope || !req.actor.keyId || !req.actor.agentId)) {
      throw forbidden("A full company agent key is required for live events");
    }
    const context: CompanyLiveContext = {
      companyId,
      actor: req.actor,
      actorType: req.actor.type as "board" | "agent",
      actorId: req.actor.type === "agent" ? req.actor.agentId! : req.actor.userId ?? "board",
      ...(req.actor.type === "agent" ? { apiKeyId: req.actor.keyId } : {}),
    };
    let active = true;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    let delivery: ReturnType<typeof createCompanyLiveDelivery> | undefined;
    const cleanup = () => {
      if (!active) return;
      active = false;
      if (keepalive) clearInterval(keepalive);
      unsubscribe?.(); delivery?.dispose(); connections.delete(finish);
    };
    const finish = () => { cleanup(); if (!res.writableEnded) res.end(); };
    const socket: CompanyLiveSink = {
      get readyState() { return active && !res.destroyed && !res.writableEnded ? 1 : 3; },
      get bufferedAmount() { return res.writableLength; },
      send(data, callback) { res.write(`data: ${data}\n\n`, "utf8", error => callback?.(error ?? undefined)); },
      close: finish,
    };
    res.once("close", cleanup); res.once("error", finish);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders(); res.write(": connected\n\n");
    delivery = createCompanyLiveDelivery(db, context, socket);
    unsubscribe = (options.subscribe ?? subscribeCompanyLiveEvents)(companyId, event => delivery!.enqueue(event));
    connections.add(finish);
    // A live connection has a concrete network keepalive obligation; it performs no idle SQL scans.
    keepalive = setInterval(() => {
      if (!active || res.destroyed || res.writableEnded || res.writableLength > 1024 * 1024) { finish(); return; }
      res.write(": keepalive\n\n");
    }, options.keepaliveMs ?? 30_000);
    keepalive.unref?.();
    // The passive read stream does not hold idle admission work. Per-event authorization remains tracked.
    completeIdleReadOnlyResponse(req, req.app);
  });
  return { router, get size() { return connections.size; }, close() { closed = true; for (const finish of [...connections]) finish(); } };
}
