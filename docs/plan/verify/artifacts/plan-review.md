# Planning artifact review — whole project plan (brief, 4 EPICs, 14 REQs, context, handoff)

No frontmatter `id`. This is a planning-artifact review, not implementation review, not TASK
completion proof and not a pipeline approval.

## Writer / parent inputs

- Target / artifact kind / stage: project plan with specified REQs, written as a handoff for a later session.
- Artifact paths: `docs/plan/HANDOFF.md`, `project.md`, `workflow.md`, `config.json`, `INDEX.md`,
  `briefs/BRIEF-1-one-window.md`, `epics/EPIC-1..4-*.md`, `reqs/REQ-1..14-*.md`,
  `context/platform.md`, `context/CATALOG.md`, `context/plan/CTX-1-*.md`, `context/project/CTX-2-*.md`, `context/project/CTX-3-*.md`.
- Author: the planning session of 2026-11-13 (the lead agent of that session).
- Reviewer: a fresh read-only subagent running Claude Opus (claude-opus-5-5), started only for this review, with no shared context.
- Independence / availability: independent.
- Upstream: CTX-1 (the founder's decisions), BRIEF-1.
- Template / quality inputs: `references/spec-quality.md`, `references/readiness.md`, `references/model.md`, `templates/artifact-review.md`, `templates/req-template.md` from the planning plugin.
- Config: `docs/plan/config.json` validated `ok: true` (schema 1, `max_review_rounds: 3`).
- Round / limit: 1 / 3.

## Reviewer's report (round 1, as returned)

- **Verdict:** needs-work
- **Overflow:** true. Further material items: (a) Paperclip's frame-protection headers are removed inside the extension; (b) two checkouts can deploy into the live folder; (c) REQ-1's list of folders to check for uncommitted work is incomplete.
- **Assessed:** CTX-1, HANDOFF, project.md, platform.md, BRIEF-1, REQ-3, REQ-5, REQ-7 and REQ-11 in full; REQ-1, -2, -4, -6, -8, -9, -10, -12, -14 in part; REQ-13, workflow.md, EPIC frontmatter and `verify/` by search. Code: Threadkeeper `scripts/build-extension.mjs` (HEAD and working-tree diff), `src/core/paperclip/{live,sync}.ts`, the sandbox list in `workspace/useWorkspace.ts`; Paperclip `ui/src/api/client.ts`, `ui/src/main.tsx`, `ui/src/lib/websocket-url.ts`, `packages/shared/src/constants.ts`, `packages/shared/src/types/plugin.ts`, `packages/plugins/sdk/src/types.ts:260-300`, `server/src/realtime/plugin-api-ws.ts`, `server/src/middleware/{auth,board-mutation-guard}.ts`, `cli/src/services/service-manager.ts:155-172`, `cli/src/onboard-service.ts:138-158`, CSP headers in `routes/{assets,issues}.ts`, the plugin services list.
- **Spot-checks that passed:** `BASE = "/api"`, `BrowserRouter`, WebSocket URL from `window.location`; plugin slot types, `routePath`, reserved route names, `PluginToolDeclaration`, `ToolRunContext`/`ToolResult`, websocket routes proxying upstream, the five tool-policy decisions; launchd plist with `RunAtLoad`/`KeepAlive` and the `PAPERCLIP_SHIM_PATH` restriction; `TK_OUT_DIR` builds get no key and a path-based ID; `--print-id` exists; `buildId` uses the git sha; `live.ts` and `sync.ts` header claims; `agent.run.cancelled` exists; every `blocked_by`/`blocks` pair is mutual.

### Findings

| Finding | Category | Location | Source / conflicting requirement | Impact | Concrete fix | Recheck evidence needed |
|---|---|---|---|---|---|---|
| F-1 | security | REQ-11 D-8, FR-3, AC-6; REQ-9 D-4, FR-2 | REQ-11 limits actions to sessions linked to the agent's task, but REQ-9 lets any reading agent link any session to any task in the company | A planted instruction in session text can make a trusted agent link a session and then send to it; an untrusted agent can link sessions to a trusted agent's task | Count only founder or automatic links (or sessions the agent started) as acting scope; let agents link only to their own task; add negative AC for self-link and cross-task link; mark session text returned to agents as untrusted data | REQ-11 AC for link-then-send denied; REQ-9 FR-2 restriction |
| F-2 | security | REQ-7 D-9, D-10, FR-1, Constraints; REQ-11 delivery; REQ-14 AC-2 | On `local_trusted` every local non-agent caller is the board and the mutation guard skips its origin check; bridge route auth mode not stated | Any local process could pair, poll, receive action requests or key values, or feed agents false rows; "paired extension" ACs cannot be tested | Add a bridge secret: one-time code confirmed by a board user, random token on every call, routes `auth: "board"`, agent credentials refused | New REQ-7 FR and ACs for missing token and agent credential |
| F-3 | graph | REQ-6 D-9, FR-1; REQ-7 D-2; REQ-9 Planning inputs, FR-3, FR-4; HANDOFF section 3 | Two lanes extend one plugin that no REQ creates or installs; REQ-9 FR-4 needs the Paperclip view (REQ-5) but says REQ-5 is not needed | Duplicate scaffolding or a missing plugin; REQ-9 cannot pass if REQ-5 lags | REQ-7 owns the scaffold, install and enable with an AC; REQ-6 blocked by REQ-7; REQ-9 blocked by REQ-5 | Frontmatter; REQ-7 AC for enabled after restart; clean `plan.py validate` |
| F-4 | readiness honesty | All 14 REQs "Artifact review"; HANDOFF section 10 | The REQs cited this review file before it existed | A fresh session would treat the review gate as cleared | Replace the line with the true state; record this verdict | This file exists; Readiness lines match it |
| F-5 | security | REQ-11 FR-5, AC-8, UI Layout | Switches enforced only on the Paperclip side; disagreement on reconnect undefined | Switching off in the extension while Paperclip is down, then reconnecting, could let a queued send through | Extension keeps its own master and provider switches; both must allow; "off" wins on reconnect; earlier requests dropped | Extension-side AC for switch-off during disconnect |

**Reviewer's minor notes (not findings):** Q-7 default differed between project.md/BRIEF-1 and HANDOFF/REQ-11; REQ-1 FR-1 checked too few folders; the workstream changes the Mac helper's role and adds `webRequest`; the header-removal rule also strips Paperclip's own `CSP: sandbox` on uploaded assets; end-to-end runs with a `/tmp/tk-build` build need that build's ID allowed; with Q-11's default the old checkout can still deploy into the live folder; CTX-1 G-1 said "unmodified" while REQ-5, REQ-6 and REQ-13 edit Paperclip's interface; line citations drifted in the working tree (covered by REQ-1 FR-3).

## Dispositions (writer, 2026-11-13)

| Finding | Disposition | Changed paths / sections | Recheck |
|---|---|---|---|
| F-1 | Fixed | REQ-11 D-8, FR-3 (new negative scenario), AC-14, Coverage; REQ-9 D-4, FR-2, AC-8, AC-10, AC-11 (new), Coverage; REQ-8 FR-8, AC-14 (new); REQ-10 FR-2 contract, AC-12 (new) | Pending |
| F-2 | Fixed | REQ-7 D-9, D-12 (new), FR-8 (new), AC-14, AC-15 (new), Constraints, UI Layout, Coverage | Pending |
| F-3 | Fixed | REQ-7 D-13, FR-9, AC-16 (new), `blocks`; REQ-6 `blocked_by`, D-9, gaps, load gates; REQ-5 `blocks`; REQ-9 `blocked_by`, Planning inputs, gaps; EPIC-2 and EPIC-3 tables and text; HANDOFF section 3 | Pending |
| F-4 | Fixed | Every REQ's Readiness "Artifact review" line; HANDOFF section 10; this file | Pending |
| F-5 | Fixed | REQ-11 FR-5, UI Layout, AC-15 (new), Coverage | Pending |
| Overflow (a) | Fixed | REQ-5 D-10, FR-9, AC-13 (new), Coverage | Pending |
| Overflow (b) | Fixed by rule | REQ-3 Constraints ("Two writers"); HANDOFF section 2 | Pending |
| Overflow (c) | Fixed | REQ-1 FR-1 contract values, edge scenario, AC-7 | Pending |
| Minor: Q-7 | Fixed | project.md, BRIEF-1 | — |
| Minor: helper role | Recorded | platform.md "In flux"; REQ-4 `readiness_gaps` | — |
| Minor: test build ID | Fixed | REQ-5 Env & config | — |
| Minor: "unmodified" | Raised to the founder as Q-12 | project.md, BRIEF-1 (G-1 note and Q-12), HANDOFF section 6 | — |
| Minor: citation drift | No change; REQ-1 FR-3 covers it | — | — |

- Remaining blockers / missing inputs: none from this review beyond the recheck.
- Next bounded action: an independent recheck (round 2 of 3) of the changed sections listed above,
  plus REQ-6, REQ-9 and REQ-11 as a whole. Do it at the start of the next session or before REQ-7 is scoped.
- Independent review pending: yes. The fixes were made by the writer and have not been rechecked by a reviewer.
