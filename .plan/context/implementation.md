---
id: CTX-4
title: Current fork integration map
level: project
kind: code
type: repo
updated: 2026-11-14
---

# Current integration map

The founder approved the then-uncommitted Threadkeeper snapshot as the import baseline, before
the separate multi-profile merge. Its committed history is retained as an ancestor of
`merge/threadkeeper-import`, and its approved files were overlaid under `extension/`.
`verify/baseline.json` records all 443 source hashes. `verify/preservation.json` records the
actual unchanged original files, Git head and live build manifest. No live deployment is implied.

Historical `src/` citations now refer to `extension/src/`; historical `paperclip/` citations refer
to this fork's root. This map supersedes the old single-active-account and unproven API assumptions.
Provider IDs, thread keys, encrypted profile jars and account attribution retain the approved
multi-profile snapshot's behavior.

| Owner | Current source | Contract |
|---|---|---|
| Repository checks | `scripts/threadkeeper-check.mjs`, `threadkeeper-deploy.mjs` | Separate React 18 npm extension; safe checks only build `/tmp/tk-build`; intentional deploy requires `TK_LIVE_DIR` |
| Native service | `extension/mac-helper/{install,core,host}.cjs` | Installation records fixed Node/CLI/shim paths; lifecycle messages cannot choose executable paths or arguments; first service install is an explicit action |
| Connection lifecycle | `extension/src/core/paperclip/lifecycle.ts` | Visible-only 2-second probes, 5/30-second cadence, fixed start coordination, authenticated key verification, foreign-port refusal |
| Extension integration | `extension/src/core/paperclip/integration-runtime.ts`, `integration-client.ts` | Manager-only dispatch, fixed board routes, private bridge ownership, current-consent checks for model keys |
| Shell and frame | `extension/src/entrypoints/manager/{App,PaperclipView,PaperclipConnection}.tsx`, `core/paperclip/host.ts` | Persistent direct-child app frame, validated origins/windows/paths, deep-link hydration, immediate health refresh after native socket loss |
| Fused layout | `extension/src/entrypoints/manager/PaperclipFusion.ts`, `ui/src/lib/threadkeeper-{host-fusion,host-slot,overlays}.ts` | Layered view above transparent Paperclip content; verified slot placement; blocking-overlay raise and notice cutouts; switching fallback |
| Header protection | `extension/src/core/embed/{rules,workspace-tabs}.ts` | Paperclip's configured host retains security headers on every port, including nested uploaded documents |
| Browser bridge | `extension/src/core/paperclip/{bridge,bridge-protocol,bridge-query}.ts` | Independent per-company pairing, grants, bounded UTF-8 inventory, browser-owned retrieval/redaction, private token and revocation state |
| Current observation | `extension/src/core/paperclip/observations.ts`, content reporter and manager frame-detach hook | Known-state heartbeats, live-frame ledger, five-second settled transitions, immediate detach or bounded heartbeat expiry |
| Provider delivery | `extension/src/core/paperclip/actions.ts`, `core/embed/session-delivery.ts`, `manager/paperclip-actions.ts` | Durable idempotency, explicit task/account/frame, current privacy and policy, live document/URL checks, no automatic uncertain-delivery retry |
| Plugin | `packages/plugins/plugin-browser-sessions/` | One company-scoped plugin owns migrations, inventory, queries, links/tombstones, notifications, action history, settings and UI slots |
| Tool governance | `server/src/services/tool-gateway.ts`, plugin route/policy integration and SDK `types.ts` | Gateway-derived task identity; shared companies receive narrowly scoped read access through existing policies; explicit denies/profiles and action gates remain authoritative |
| Paperclip interface | `ui/src/lib/threadkeeper-host.ts`, host component, Search/palette and CoordinatorSidebar integration | Runtime extension allowlist, native host messages, actual default-sidebar outlet, independent session search and native secret binding picker |
| Authenticated live delivery | `server/src/realtime/company-live-delivery.ts`, `server/src/routes/company-live-events-stream.ts`, `ui/src/lib/hosted-live-transport.ts` | Verified hosted UI can receive the same filtered company events over a credentialed HTTP stream; ordinary WebSocket delivery uses the same viewer policy |
| Current library | `extension/src/core/paperclip/{sync,mapper}.ts` | Named task and run-only hints reuse per-task import without moving periodic cursors; verified company provenance enables ID-only automatic links |
| Model credentials | `extension/src/core/paperclip/credentials.ts` and feature boundaries | Explicit source/transfer consent; references persist, values stay in the feature call's memory; successful readback precedes deletion; offline remote features pause |
| HTTP privacy | `server/src/middleware/` plugin bridge log rules | Bridge/poll tokens and private transcript/result bodies are excluded from generic HTTP logs |

The source shim supplies `PAPERCLIP_THREADKEEPER_EXTENSION_IDS` and
`PAPERCLIP_BUNDLED_PLUGIN_ROOT` from fixed install-time configuration. A source server started
another way needs those settings explicitly. The first-party plugin uses the normal loader and
database migration path; test-instance installation does not install it in a user's instance.

REQ-6 now uses the layered variant in `../reqs/REQ-6-design.md`, with view switching as fallback.
The original clipping technique failed practical wheel/trackpad scrolling; retained spike results
distinguish that failure from the layered variant. The current fix-all cycle repairs direct entry
and palette-close behavior and adds the compact interface in `../reqs/REQ-6-ui-supplement.md`.
New final browser evidence is pending; see `../verify/fix-all-cycle.md` for the source/spec gaps.
Browser acceptance uses isolated build/profile fixtures. The native optional-permission prompt
remains a separate evidence boundary when the runner cannot operate it. Real signed-in-provider
delivery and launchd persistence require their specified founder-operated checks. See the
acceptance report and validation records for actual outcomes.

## Authenticated transport decision, 2026-11-14

Controlled Chrome and Edge fixtures showed the native company WebSocket connecting in an ordinary
page and failing inside the extension frame for the same signed-in user and company. HTTP sign-in
and reads inside the frame succeeded. This is an observed realm boundary; no cookie-policy root
cause is asserted. The implementation reuses HTTP authentication and the existing company-event
viewer filtering for an event-stream fallback selected only after the extension-host handshake.
It changes no cookie policy, creates no new credentials, and uses no authentication values in URLs.
Backend forwarding and cleanup tests and an ordinary HTTP runtime receipt exist; browser-level
authenticated stream acceptance is recorded separately, never inferred from those tests.
