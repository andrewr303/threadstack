# Final bounded database-cleanup hook qualification

The final unmodified, serial Node24.22.2 recheck passes both complete files:166tests, zero failures/skips, exit0,207.29seconds. Native-safe-replacement contributes70cases; Git-workspace-expiration96. The original30-second hook budget, assertions, configuration and source bytes are unchanged. No source edit or timeout workaround was introduced.

## Qualification evidence

`general-hooks-quiet-final-node24.log` and its JSON receipt are the authoritative final result. The parent released this run only after broad jobs ended; compact held its own large database lane until this pair completed. This declares the scheduling context rather than asserting the entire host was idle. The normal root/server config ran with its existing maxWorkers1. No instrumentation, performance environment, deferred deletion or synchronous-blocking workaround ran; the log has zero diagnostic markers. Isolated wrapper/child sessions recorded no incoming signals.

Task-baseline hashes and start/end root/server-config hashes match. A read-only cleanup check after completion found no live processes in the recorded owned wrapper/child PIDs or groups. The original helper did not export a separate PostgreSQL root path, so no such path or direct removal readback was invented. Its original afterAll database-cleanup await returned successfully. No global/temp-directory scan or cleanup was performed.

## Preserved earlier failures and diagnosis

The original failures are afterAll hooks, not afterEach. Native line78 awaits database cleanup; Git line69 closes its client, cleans the database and removes its owned fixture.

The first combined recheck received an external SIGTERM (tool exit143) with no final test summary and stale running metadata. It remains interrupted/unqualified. The parent then introduced isolated child sessions and signal receipts before the individual retries. This worker sent no termination signal.

Individual unmodified retries reproduced both hook failures:Native70assertions passed but afterAll crossed30seconds (fileexit1); Git96assertions passed but afterAll crossed30seconds (fileexit1). Neither isolated wrapper recorded an incoming signal. These were concrete test-teardown failures, not failed product assertions.

One authorized runtime-only Vite pretransform then instrumented SQL client.end requests/settlement and helper cleanup boundaries without changing tests or deadlines. Its full Native70-case diagnostic passed. Measured cleanup:registered clients10ms; PostgreSQL owner stop5008ms; owned-directory removal9531ms; total14549ms. Thus no deterministic client-end/owner-stop hang was shown in that run. Filesystem removal was its longest measured stage, but this does not establish the exact cause of the earlier >30-second failures. The interim last-pending-directory observation was updated after its completion.

The transform adds observational promise-finally markers, so its pass is diagnostic and is not substituted for final unmodified qualification. Config, syntax checks, raw stage events and signals are retained. No connection URLs or credential contents were logged. No further probe or speculative helper fix was applied.

## Scope and limits

All source remains unchanged. Protected Node24 runtime, credential-denying sandbox, provider-environment scrub and ordinary test deadlines remained active. Exact command arrays and timing records are beside the logs. The root-level originally loaded hook failures remain visible; exact causality is unproven and no code repair is claimed for them.

The required ult-debugger/TypeScript workflow was followed; its hook-log triage returned low confidence because Vitest hook reports are not a V8 crash trace. No build, provider login/generation, Git mutation or live-folder operation was performed. Parent aggregation/CI remains separate.
