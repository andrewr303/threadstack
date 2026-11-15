import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { expect, it } from "vitest";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";

it.each([200, 401, 500])("keeps browser transcript and pairing credentials out of HTTP %s logs", async (status) => {
  const chunks: string[] = []; const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } });
  const app = express(); app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream))); app.use(express.json());
  app.post("/api/plugins/browser-sessions/api/bridge/results", (req, res) => { (res as unknown as { __errorContext: unknown }).__errorContext = { error: { message: "transcript-canary" }, reqBody: req.body }; res.status(status).json({ ok: status === 200 }); });
  await request(app).post("/api/plugins/browser-sessions/api/bridge/results").set("x-threadkeeper-bridge-token", "token-canary").send({ pollToken: "poll-canary", results: [{ content: "transcript-canary" }] });
  const output = chunks.join(""); expect(output).not.toContain("canary"); expect(output).toContain("/api/plugins/:pluginId/api/:protocol");
});
