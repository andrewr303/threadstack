import { expect, it } from "vitest";
import * as contracts from "../src/contracts.js";

// R3 F-7: the deadline chain is exported from the wire contract so a fork-root test can check both packages together.
it("R3 F-7: exports the action timing chain from contracts.ts and keeps it inside REQ-11's waits", () => {
  const { SEND_TIMEOUT_MS, START_TIMEOUT_MS, ACTION_REPORT_MARGIN_MS, ACTION_SETTLE_MS, REQUEST_TIMEOUT_MS } = contracts as unknown as Record<string, number>;
  for (const value of [SEND_TIMEOUT_MS, START_TIMEOUT_MS, ACTION_REPORT_MARGIN_MS, ACTION_SETTLE_MS, REQUEST_TIMEOUT_MS]) expect(Number.isFinite(value)).toBe(true);
  expect(ACTION_SETTLE_MS).toBeLessThanOrEqual(10_000);
  expect(SEND_TIMEOUT_MS - ACTION_REPORT_MARGIN_MS - 1_500).toBeGreaterThanOrEqual(30_000 + 15_000 + 2_500);
  expect(START_TIMEOUT_MS - ACTION_REPORT_MARGIN_MS - 1_500).toBeGreaterThanOrEqual(62_000);
});
