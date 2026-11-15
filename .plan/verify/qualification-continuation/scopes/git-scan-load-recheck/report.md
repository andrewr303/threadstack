# Git scan HTTP load fixture repair

**PASS: all four cases; explicit test-program typecheck passes.** Only `server/src/__tests__/file-resources-git-scan-load.test.ts` changed.

## Reproduction and capacity evidence

The unchanged complete file reproduces the broad-run failure: the 15-second single-flight assertion sees **126 joins instead of 498**. The two held scans each have 63 joiners, so only 128 HTTP requests reached the application.

The inherited file-descriptor limit is 1,048,575 soft / unlimited hard; low FD capacity was refuted. Read-only `sysctl` reports `kern.ipc.somaxconn=128`. Node 24.22.2's actual default agent has `maxSockets=Infinity` and `maxTotalSockets=Infinity`.

An owned minimal HTTP control under the same protected runtime launches 500 requests in one burst and holds responses: only **128 accepted connections** at 120ms, 1.02s and 4.02s, with **372 ECONNRESET** failures. An otherwise identical control admits requests in event-driven batches of 64: **all 500 connections held by 108ms**, still 500 at 1s/4s, with zero errors. This isolates the synthetic TCP admission burst from scheduler behavior. No sysctl, resource limit, agent default or production code changed.

## Fixture repair

The test now waits for each batch's actual server `request` events before admitting the next batch. All responses remain held behind the same scan gate until **all 500 requests are simultaneously in flight**. An added assertion proves 500 live TCP connections at that barrier. Promise rejections are observed immediately, and unfinished admission gates reject during cleanup.

All original expectations remain byte-for-byte: exact 498 joins; globally two active scans and no queued scans; all 500 HTTP 200 responses; exactly two underlying scans; health p99 below 250ms; and final released scheduler slots. The original 15-second admission wait and 60-second case deadline remain unchanged. No retry, skip or larger timeout was added.

## Verification

- RED unchanged whole file: **1 failed / 3 passed**; exact admission assertion captured.
- Capacity controls: **128 vs 500** simultaneous held connections, zero errors for batched admission.
- GREEN whole file: **4 passed, zero skipped**, 221ms of tests. Runtime metrics: **500 held connections, 500 HTTP 200, 498 joins, two scans, peak active two, health p99 1.99ms**.
- Explicit no-emit test-program typecheck: **exit 0**.
- Bounded final scope/integration check: all original expectation lines retained; diff check passes; final hash in `receipt.json`.

All commands ran through the existing Node24.22.2 credential-denying wrapper. The owned control listeners and processes exited normally. ult-debugger router/TypeScript specialist and retained trace guided diagnosis. This establishes these four cases locally, not a full-suite or hosted CI pass.
