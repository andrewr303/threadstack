# OpenAPI route-catalog repair

The company HTTP live-event route was already mounted at `/api` in `server/src/app.ts` and documented in the production OpenAPI registry and `docs/api/companies.md`. The exact mounted-route coverage test did not list `company-live-events-stream.ts` in its source-file-to-prefix catalog. It therefore called that route file unknown and the existing documented endpoint extra.

Changed only `server/src/__tests__/openapi-routes.test.ts`: register `company-live-events-stream.ts` with its actual `/api` mount. Route discovery now checks that endpoint against the production spec. No assertion, exclusion, auth guard, route, or transport implementation changed.

## Evidence

- Runtime: Node v24.22.2; Vitest v5.0.3, parent qualification wrapper and its sandbox/environment policy.
- RED: `python3 /tmp/tk-continue/runtime/run-qualification.py openapi-red pnpm exec vitest run --project @paperclipai/server server/src/__tests__/openapi-routes.test.ts --maxWorkers 1` — exit 1, 50 passed and the exact coverage test failed with the missing catalog file and extra endpoint.
- GREEN: the same command with receipt name `openapi-green` — exit 0, all 51 tests passed.
- `source-hashes.json` records before/after hashes. `change.patch` is the exact one-line patch.
- The required ult-debugger triage ran against the RED log; it does not recognize Vitest assertion formatting, so `triage-red.json` records no parsed trace. The full original assertion diff remains in `openapi-red.log`.
- No server typecheck was repeated: this change only adds a literal entry to an existing test catalog; the focused suite transforms and executes that test. No production TypeScript or metadata schema changed.
- Existing browser evidence remains applicable to product behavior because the product implementation is unchanged. No browser rerun, build, service, live output, Git mutation, or publication was performed by this repair.
