# HANDOFF — Paperclip + Threadkeeper merge

> Current implementation update (2026-11-14): the founder approved using the working snapshot and
> installing pinned dependencies. The original merge-before-start gate below is historical and
> superseded by that recorded alternative. Work is in the nested Paperclip fork, with original
> files/live output preserved. Read `verify/final/report.md` and `verify/final/release-plan.md` for
> current proof and the still-required specific live-transition approval.

Written 2026-11-13 by the planning session. This is the authored session distillate: read it first,
then run `sdd.py resume` (commands at the end) and derive Next from the graph, not from this file.

## 1. Original start gate and current authorization

**Implementation update, 2026-11-13:** the founder requested full implementation of this plan and
answered `yes` to using the current working snapshot in the Paperclip fork and installing its pinned
dependencies while preserving the original checkout and live extension. This explicitly authorizes
the current-snapshot alternative to the original merge-first gate below. It does **not** establish
that the multi-profile work is committed or merged. The source `main` remains at `9078b2b`; its
uncommitted snapshot is recorded in `verify/baseline.json` (443 files). Work is in
`/Users/andrew/dev/threadkeeper/paperclip`, branch `merge/threadkeeper-import`; the old checkout and
its `docs/plan/` remain unchanged. The original start-gate wording below is historical and is
superseded only to this stated extent. Completion, review, runtime proof and live-deploy gates remain.

Nothing in this plan is specified further into TASKs, loaded or built until the founder confirms
that their separate multi-profile workstream is merged into Threadkeeper `main` (REQ-1, CTX-1 G-6).
In the founder's words: "don't make any changes directly, you are creating handoff with full specs
for a new session to use. I'm currently making the changes I mentioned earlier that allow for using
multiple profiles within the same extension and can't have colliding changes, plus I don't want any
of this to be done until those fixes are made."

The workstream has four parts; REQ-1 tracks each as merged or pending:

1. Several accounts of one provider embedded in the extension (like several browser profiles in one),
   instead of opening a separate Chrome window. Moving between accounts from the tabs, the session
   sidebar and the account menu.
2. Claude treated as the whole platform: Claude Code as the default landing page, changeable in
   settings, and no provider navigation cut off (today Claude's sidebar and its code/chat toggle are hidden).
3. Indexing for every signed-in profile: coding sessions, cowork and chat sessions, Grok bot, dots
   and Muse sessions (the founder has two Grok accounts with many Grok bots).
4. Filter, sort and group controls (bots, coding, chats, provider; date; grouping by any of these)
   for the session sidebar, Threads and Dashboard.

On 2026-11-13 that work was in progress and uncommitted: 66 changed tracked files and 11 new files
(`context/platform.md`, "In flux"). Do not touch those files.

## 2. The live browser rule — read before running anything

- The founder's Microsoft Edge loads Threadkeeper from `/Users/andrew/dev/threadkeeper/.output/chrome-mv3`
  with the path-based ID `bajiblleoodfabmofjmcjeejhbjikfkp` and no manifest key, and it reloads
  itself when that folder's build changes.
- So `npm run build` and `npm run check` in the Threadkeeper root are deploys to the founder's
  browser. **Never run them.** Use `npx tsc --noEmit`, `npx vitest run`,
  `TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs` and
  `TK_E2E_DIST=/tmp/tk-build node scripts/run-workspace-e2e.mjs`.
- Never add a manifest `key` to that folder, never build it with `TK_STABLE_ID=1`, never regenerate
  `shared/extension-key.json`: the ID would change and the browser would open an empty library.
- Deploys, installs (`npm ci`, `pnpm install`), pushes, plugin installs and service registration
  need the founder's go-ahead for that specific action. The current authorization covers pinned
  dependency installs in the fork; it does not authorize live deployment, service registration,
  publishing, or transmission of existing model-key values.
- After the founder's first deploy from the fork (REQ-3 `deploy:extension`), never build in the old
  checkout again: a plain build there would put pre-merge code back into the live folder. The running
  build's commit shows in the extension's Diagnostics ("Files on disk").

## 3. Order of work

1. **Brief aligned for implementation.** The founder's full-implementation instruction and snapshot
   approval authorize the written plan with its documented defaults; unanswered product choices
   remain explicit assumptions, not invented individual answers.
2. **REQ-1** records the approved current-snapshot alternative. Its baseline/code-map and completion
   checks still need truthful evidence; do not mark the original merge-only criteria passed.
3. **EPIC-1**: REQ-2 (import into the fork) then REQ-3 (one check, safe deploy).
4. **REQ-4** (Paperclip running and connected).
5. After REQ-4, REQ-5 (Paperclip view) and REQ-7 (bridge; creates and installs the plugin) can run
   side by side. Then:
   - REQ-6 (Threadkeeper entries in Paperclip's sidebar; spike first) needs REQ-5 and REQ-7.
   - REQ-8 (read tools) needs REQ-7; REQ-9 (links) needs REQ-5 and REQ-7.
   - REQ-10 (wake-ups) needs REQ-9; REQ-11 (trusted actions) needs REQ-8 and REQ-9.
   - REQ-12 needs REQ-7; REQ-13 needs REQ-8; REQ-14 needs REQ-7 and only happens if the founder keeps it (Q-9).
   - REQ-6 to REQ-13 extend one plugin (`packages/plugins/plugin-browser-sessions`), so two of them
     are never built at the same time.
6. For each REQ: refine to readiness 4 or more, scope into TASKs, pass the load gate, build with
   TDD, then independent spec review, then independent quality review, then the complete gate.

## 4. Historical planning readiness gaps (see current checkpoint)

| REQ | Readiness | Open item | How to close it |
|---|---|---|---|
| REQ-1 | 3 | The founder's confirmation | Ask; then run it |
| REQ-2 | 4 | Baseline commit and test counts | Recorded by REQ-1 |
| REQ-3 | 4 | Does the extension's tooling pass on Node 24 | Try it during the build |
| REQ-4 | 3 | How the fork's checkout becomes the background service (D-2) | Read `paperclip/cli/src/onboard-service.ts` and `cli/src/services/service-manager.ts`; `/ultimate-sdd:design REQ-4` |
| REQ-5 | 4 | Real server inside the frame never tried | First task: prove live updates, the service worker and sign-in inside the frame |
| REQ-6 | 3 | Fused sidebar technique unproven (D-3) | Five-check spike in the REQ; if it fails, ask the founder Q-3 |
| REQ-7 | 3 | Transport for Paperclip-to-extension requests (D-3); how the plugin is installed and kept enabled (D-13) | Spike a long-held request from the MV3 service worker and from the manager page; read the plugin database client, test harness and install path; design |
| REQ-8 | 3 | How a plugin tool reaches a running agent | Read `paperclip/server/src/services/tool-gateway.ts` and `plugin-tool-dispatcher.ts` |
| REQ-9 | 3 | How a plugin finds a run's task | Read `ctx.agents` and `ctx.issues` in the plugin SDK; else make `issueId` required |
| REQ-10 | 3 | Plugin calls for a task comment and a wake-up | Read `PluginIssuesClient` in the plugin SDK |
| REQ-11 | 2 | Tool policies for plugin tools (D-2); how a message is typed into a provider page (D-5); account model (D-6) | Read the tool gateway and policy services; spike on a stand-in page, then one real provider with the founder present; re-read accounts after REQ-1 |
| REQ-12 | 4 | Run event payload fields | Read during build; a fallback is specified |
| REQ-13 | 3 | Paperclip's search page and command palette unread | Read `paperclip/ui/src/pages/Search.tsx` and the palette |
| REQ-14 | 2 | Wanted at all (Q-9); can a plugin read secret values; may values cross the bridge; behaviour when Paperclip is down | The founder answers; read the plugin secrets client; design |

## 5. Decisions made in this session

The founder's (CTX-1):

- G-1 Embed the real Paperclip app in the extension window, served by a Paperclip server on this Mac
  that the helper starts; Threadkeeper's views become entries in Paperclip's sidebar through a
  first-party Paperclip plugin.
- G-2 The library (conversations, embeddings, reranking) stays in the extension; agents reach it
  through the extension while the browser runs; Paperclip tasks keep flowing into the library.
- G-3 Trusted agents start sessions and send messages without asking, within rate limits.
- G-4 Hard fork of Paperclip; its core may be edited; upstream is not followed.
- G-5, G-6 The multi-profile workstream is separate and first; nothing here starts before it merges.

The planner's (each recorded as `assumed` in its REQ, with its boundary):

- The extension stays its own npm package under `extension/`, outside the pnpm workspace (the
  workspace forces React 19; the extension uses React 18).
- The plan moves to `.plan/` at the fork root (Paperclip's `docs/` is its documentation site).
- The fork's extension is deployed into the folder the founder's browser already loads, so the ID
  and the library never change (Q-11 default).
- Paperclip is shown in a frame that is a direct child of the extension page, like provider pages,
  because only direct children keep their sign-ins (CTX-2 rows 4a, 4b).
- One first-party plugin, `browser-sessions`, holds the bridge, the agent tools, the task tab, the
  dashboard widget and the sidebar entries.
- The bridge reuses the message shapes, validators, limits, secret redaction and privacy filter of
  the existing Still integration (`src/core/dock/*`) under the protocol id `paperclip-threadkeeper/1`.
- Sessions are shared with a Paperclip company only after the founder ticks it; private sessions never leave.
- Agent actions are off by default behind three switches: a master switch, one per provider, and a
  trust mark per agent; trusted agents act only on sessions linked to their current task.
- REQ-9 and REQ-11 do not wait for REQ-6, the riskiest interface work.

Added after the independent review (2026-11-13, `verify/artifacts/plan-review.md`):

- The bridge has its own identity: pairing with an 8-character code confirmed in Paperclip, then a
  bridge token on every call; agent credentials are refused on bridge routes (REQ-7 D-12).
- REQ-7 creates, installs and keeps enabled the plugin; REQ-6 waits for it (REQ-7 D-13).
- Agent-made links never let an agent act on a session; acting scope is founder links, automatic
  links and sessions the agent started for its task (REQ-11 D-8). Agents may link only to their own task (REQ-9 D-4).
- The extension keeps its own master switch and provider switches; an action needs both sides;
  "off" wins on reconnect; requests from before a switch-off are dropped (REQ-11 FR-5).
- Session text returned to agents is marked as untrusted data (REQ-8 FR-8); titles in task comments
  are cut and quoted (REQ-10 FR-2).
- Paperclip's own security headers are kept inside the extension window (REQ-5 D-10).

## 6. Open questions for the founder (defaults hold if unanswered)

| ID | Question | Default |
|---|---|---|
| Q-1 | Where is the fork pushed? | Local branch only |
| Q-2 | Name for Threadkeeper's Dashboard in Paperclip's sidebar | "Session board" |
| Q-3 | If the fused sidebar fails, accept view switching? | Yes |
| Q-4 | May every agent in a shared company read sessions? | Yes |
| Q-5 | Which sessions may a trusted agent act on? | Only those linked to its current task |
| Q-6 | Rate limits for trusted agents | 10 sends and 3 starts per agent per hour; 1 send per session per minute |
| Q-7 | Providers open to agent actions | All off; Claude, Claude Code, ChatGPT and Codex supported first |
| Q-8 | Rename the product or extension? | No |
| Q-9 | Keep REQ-14 (model keys in one place)? | Keep, last |
| Q-10 | Where does the fork folder live? | Where it is (`/Users/andrew/dev/threadkeeper/paperclip`) until pushed |
| Q-11 | Which folder does the browser load after the merge? | The same folder as today |
| Q-12 | G-1's option said Paperclip runs "unmodified"; the plan makes small edits to Paperclip's interface (REQ-5, REQ-6, REQ-13). Accept? | Yes, because the hard fork (G-4) removed the reason for "unmodified" |

## 7. Files this session wrote

Only `docs/plan/**`. No application code, no git operation, no build, no install, no push. The
Threadkeeper repository shows `docs/plan/` and `paperclip/` as untracked; leave them out of the
workstream's commits unless the founder wants them in.

## 8. Do not redo

- The code maps of both codebases (`context/platform.md`); re-verify only what changed (REQ-1 FR-3).
- The research on running several accounts of one provider inside an extension (CTX-2).
- The scan of open-source projects (CTX-3).
- The interview with the founder (CTX-1).

## 9. Commands

Plugin: `/Users/andrew/dev/Plugins/ultimate-sdd`. From `/Users/andrew/dev/threadkeeper` (after REQ-2,
from the fork root with `--root .plan`):

```
python3 /Users/andrew/dev/Plugins/ultimate-sdd/scripts/sdd.py resume --repo . --root docs/plan --json
python3 /Users/andrew/dev/Plugins/ultimate-sdd/scripts/sdd.py config --repo . --root docs/plan --json
python3 /Users/andrew/dev/Plugins/ultimate-sdd/scripts/plan.py next --root docs/plan --json
python3 /Users/andrew/dev/Plugins/ultimate-sdd/scripts/plan.py board --root docs/plan --write
python3 /Users/andrew/dev/Plugins/ultimate-sdd/scripts/plan.py validate --root docs/plan
```

`config.json` has `hooks.enabled: false` on purpose, so this plan does not load into the founder's
other sessions in this repository. REQ-1 FR-5 turns it on.

## 10. State observed at the end of this session (historical)

- `plan.py validate`: 24 artifacts, 0 errors, 0 warnings. `sdd.py config`: ok.
- `plan.py next`: `frame` — "No aligned brief and no PRD." (meaning: the founder has not confirmed BRIEF-1).
- Readiness: REQ-2, REQ-3, REQ-5 and REQ-12 at 4; REQ-11 and REQ-14 at 2; the rest at 3. All but
  REQ-1 are blocked by their dependencies.
- Independent review round 1 of 3 (fresh read-only Opus subagent): needs-work, 5 findings plus 3
  overflow items, all fixed by the writer the same day. A recheck (round 2) of the changed sections
  is pending; see `verify/artifacts/plan-review.md` for the findings, dispositions and recheck scope.

## 11. Implementation checkpoint (2026-11-13)

- Baseline: source `9078b2b261d2e12b8bc3230090f217b40e7c9b81`; clean Paperclip base
  `edb6945ff3f21f7af19580879b1e77e1605d0996`; history import commit
  `79589c00e99453352b0aafe1c8b5582af42284ba`, then the approved working snapshot overlay.
  `verify/baseline.json` retains hashes and the live manifest's original mtime/hash.
- Source-snapshot regression check: 83 Vitest files and 1,713 tests passed on Node 24.22.1;
  original producer log is retained at `verify/baseline-tests.log`. This is baseline evidence,
  not proof that the integration or its browser acceptance passed.
- Implementation designs and ownership are recorded in `verify/implementation-checkpoint.md`.
  One `TASK-1` per REQ owns all of that REQ's original AC text. TASKs are unfinished; drafting
  these records does not retroactively establish a successful load gate.
- Sidebar mode is the documented view-switching fallback while the five-check Edge/Chrome
  fused-sidebar spike remains unproven. No failed spike or fused-mode pass is claimed.
- The source-service design uses a fixed registered shim. The bridge uses per-company pairing,
  private tokens and 20-second polling; tools receive a trusted task id from the gateway.
- Shared model credentials are an opt-in flow, off by default, with remote features paused when
  linked keys cannot be read. No live model-key transmission or migration is recorded.
- Final cumulative tests, independent spec-then-quality reviews, runtime acceptance and completion
  gates remain pending. Preserve failures and material gaps instead of marking this plan complete.

## Active implementation state

The complete feature set is drafted in this fork; every REQ/TASK remains `in-progress` pending
current acceptance and review evidence. See `context/implementation.md` for current modules and
`verify/reviews/` for independent findings and repairs. Original AC text is preserved.

- The original checkout's 443 snapshot files, original Git head and live manifest bytes/mtime
  were verified unchanged in `verify/preservation.json`. No live deploy, user service registration,
  real provider send, push or publication has occurred.
- The source bridge now uses bounded three-second active polls within the twenty-second protocol
  ceiling. Known observations heartbeat every ten seconds, expire after thirty seconds, and settle
  for five seconds before notification. Actual manager iframe removal forgets its observation.
- Independent spec round 1 recorded nine findings. Repairs include pairing alphabet compatibility,
  live URL/document delivery guards, automatic link provenance/tombstones, observation freshness,
  run-only hints, complete state comments, untrusted result markers, foreign-port refusal and
  native socket-loss health refresh. Round 2 added atomic inventory item-count limits on both sides.
- Actual runtime verification uses disposable instances, not the user's Paperclip instance:
  loopback 3217 (local-trusted, isolated Postgres 55487) and 3218 (authenticated, Postgres 55488).
  Runtime metadata and owned launch/recovery information are in `/tmp/threadkeeper-acceptance-runtime.json`
  and `/tmp/threadkeeper-auth-runtime.json`; do not copy synthetic login values into plan reports.
- Pairing, search, private-session exclusion, persisted links, three native sidebar entries,
  Back/Forward navigation and sub-second offline-panel onset have actual Chromium observations.
  Authenticated and Edge journeys, media inspection and final Neo report sealing remain active.
  The native optional-host-permission prompt is outside the runner's capability; any pregranted
  loopback test manifest is a declared isolated fixture and must be restored afterward.
- The browser worker exclusively owns `/tmp/tk-build` during acceptance. Do not run a check that
  rebuilds it concurrently. A previous parent rebuild overlapped round-6 cleanup; the worker closed
  that profile and produced a consistent successor build. Preserve capture-time build identities.
- Rust 1.97.1 and rustfmt were installed only into a task-local temporary directory. Native checks
  passed. `/tmp/threadkeeper-rust-runtime.json` records paths needed by child `CARGO_HOME`,
  `RUSTUP_HOME`, `CARGO_TARGET_DIR` and task-specific PATH overrides; no global Rust was installed.
- The stale full root run `24835` was stopped with SIGINT, exit 130, after recording 51 failed tests
  in nine file summaries. It started before the final source/toolchain and is not current-source
  qualification. All six chat shards passed. Current focused repairs/reproductions and the original
  failed log remain separate; see `verify/final/full-suite-summary.json` and `full-suite-stop.json`.
- Latest extension full-check evidence is `/tmp/threadkeeper-check-extension-round6.log` (1,828
  tests and safe build passed), followed by focused packet-limit checks. Latest server layered
  typecheck, plugin 36-test/build receipts and runtime SSE receipts are named in validation records.

Current source implementation has independent SPEC-3 and QUALITY-2 passes. Chrome 13 and Edge 14
each have nine passing real journeys and one blocked native-consent case, with sealed inspected
evidence. A normal process agent also completed real paired gateway reads. The current extension
has 1,833 passing tests and a final safe isolated build. The standard production build also passes,
including the signed arm64 Runner. Verification-tool and identical-render guidance deltas are
reconciled through ordered supplements; sealed evidence was not rewritten.

Next: review the final report and decide on the plan's specific live deployment/helper/service
approval. Complete native consent, broad-suite qualification and founder-operated provider,
launchd and live-library continuity checks before claiming full acceptance or completion gates.

## Improvement round (2026-11-14)

The founder asked to improve the implementation against this plan. Read these before continuing:

- Eight independent per-REQ audits: `verify/audits/20261114/`. They found one Blocker (REQ-11: an agent could grant itself acting scope) and about 30 Majors.
- Repairs by four authors over three rounds: `verify/plugin-repair.r1.implementation.md`, `verify/extension-bridge-repair.r1.implementation.md`, `verify/lifecycle-checks-repair.r1.implementation.md`, `verify/REQ-6-TASK-1.r1.implementation.md`.
- Independent reviews: `verify/REQ-6-TASK-1.r1.spec.md` and `verify/repairs.r1.cumulative-spec.md` (FAIL), `verify/repairs.r2.cumulative-spec.md` (PASS), `verify/repairs.r2.cumulative-quality.md` (no Blocker or Major; BLOCKED only on gates), `verify/repairs.r3.cumulative-spec.md` (PASS). No quality review has been run on the round-3 code.
- REQ-6: spike results and design in `reqs/REQ-6-design.md`; fused mode is built with the layered variant. Browser evidence `.acceptances/paperclip-merge/round-17` to `round-20`; runner `extension/scripts/run-paperclip-fused-e2e.mjs`.
- Checks on the final code: extension 1,940 tests, plugin 110, related UI 97, server focused 131, guard and contract tests 13, typechecks exit 0. Not run: the full Paperclip suite, real providers, real keys, launchd, MV3 suspension.
- The review ledger (`sdd.py review-record`) refuses records while predecessor REQs are not done, so reviews are files, not ledger entries. Every load and complete gate is still `ok:false`. All REQ and TASK statuses are unchanged.
- The review budget (3 rounds) is used. Do not start a fourth round without the founder's go-ahead.

Open defects from the browser runs:

1. Opening the window on Threads with Paperclip running lands on Paperclip's page, not fused Threads (`round-19/fused-direct-entry.json`). Introduced with eager frame loading in round 3.
2. A click within about 100 ms of closing Paperclip's palette can be swallowed.

Decisions for the founder:

| ID | Decision | Current behaviour |
|---|---|---|
| Q-3 | Accept the layered fused sidebar in place of view switching | Built; switching remains the fallback |
| NF-4 | On a `local_trusted` server any local process can pair itself as the browser (REQ-7 D-12) | Unchanged; token-less HTTP routes removed |
| NF-5 | REQ-4 AC-11 says no native message when the helper is missing | One probe per window |
| N-3 | Load the Paperclip frame whenever the server runs, and whether to add a way to stay connected without the fused window | Loads eagerly |
| M-4 | Action timeout text: literal 30 seconds, or the real 60 and 75 seconds | Real seconds |
| Config | `config.json` `test_commands` lacks `pnpm test:run`; `hooks.enabled` is true although REQ-1's alternative says off | Unchanged |

Nothing was deployed. The live folder's manifest time is unchanged (Nov 13 18:00:08 2026) and Threadkeeper `main` is still `9078b2b`.

## New authorized fix-all cycle (2026-11-14)

The founder subsequently instructed `Fix all` and `Fix all and then open new PR`. This authorizes
a new bounded repair and verification cycle after the historical three-round limit above. It
does not erase that limit, rewrite prior reviews, waive failed gates, or authorize live extension
deployment, helper installation, or service registration. `max_review_rounds: 3` remains unchanged
for the new cycle.

- The two remaining browser defects are in scope: preserve a direct Threads entry through the
  eager frame's initial home route, and make the first click after closing the palette effective.
  Raw round-20 evidence records only 1/4 successful 0 ms clicks, despite its settled case passing;
  the successor run must assert the actual immediate-click outcome.
- The founder's screenshots add a compact interface: Summary / Live / Split beside the title;
  one row for category, lock, status, and thread actions; one merged Sessions/results sidebar;
  and a full-width usable Ask field. Contract: `reqs/REQ-6-ui-supplement.md`.
- Current implementation/source reconciliation: `verify/fix-all-cycle.md`. The layered variant
  remains the implementation direction inferred from continuation; no separate explicit Q-3
  answer is claimed. Original AC-10 and the other original AC text are preserved.
- Configuration is reconciled with the approved snapshot alternative: hooks are off in this
  fork, and `pnpm test:run` is recorded as the known full-suite command. That command's presence
  does not certify a pass; the interrupted broad run remains unqualified.
- Eager loading after running-server/host permission checks, truthful 60/75-second action timeout
  text, the single remembered missing-helper probe, and `local_trusted`'s local-process trust
  assumption are documented explicitly. The literal zero-native-message AC remains unmet.
- Final new-cycle command receipts are being collected in `/tmp/tk-fix-all/`. Successor browser
  rounds, final independent spec then quality review, PR publication details, and current gate
  receipts are pending. Do not use historical counts or these planned steps as final evidence.

All REQ and TASK statuses retain their unfinished values. The live extension, original checkout,
and user service remain outside the authorized test/deploy boundary. Broad Paperclip
qualification, native consent, real providers/keys, helper/launchd, MV3 suspension, and live-library
continuity remain visible until actual evidence resolves them.
