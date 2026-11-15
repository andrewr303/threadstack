# AC audit — REQ-5 (auditor model: sonnet)

> Verbatim final report of an independent read-only auditor (ultimate-sdd:verifier), persisted by the coordinator on 2026-11-14.
> Purpose: improvement backlog. Not a completion certification; no checks were executed by the auditor.

# REQ-5 / TASK-1 source-level audit (improvement backlog, not a completion certification)

**Reviewer:** read-only auditor. I did not author this code. I ran no commands. Everything below is from reading source and tests. Prior reports were used only as pointers. Review ledger: none. Complete gate: failing, as you stated, and not assessed.

## 1. Per-AC verdicts

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | PARTIAL (RUNTIME-ONLY for "sidebar visible") | `Rail.tsx:35`, `App.tsx:1144-1146` set the rail to strip form for `paperclip`. `manager-app.test.tsx:414` ("opens Paperclip in a dedicated frame…") asserts `data-view` and `data-collapsed`. Whether Paperclip's sidebar actually shows needs a browser run. |
| AC-2 | PARTIAL | The frame is created once and stays mounted (`PaperclipView.tsx:92`). It lives outside `planFrames`. Tests: `paperclip-view.test.tsx:29` and `manager-app.test.tsx:414` check same-node identity. "No document request" needs the network panel. "6 session frames stay loaded" has no test: nothing combines 6 session frames with a Paperclip frame. |
| AC-3 | PARTIAL | The stopped-state panel is tested (`paperclip-view.test.tsx:100`, `:13`). The 5 s bound is not met by design, see finding F1. |
| AC-4 | PASS-TESTED (reload itself RUNTIME-ONLY) | `host.ts:47` builds the address and `App.tsx:1110` writes it with `replaceState`. `initialPath` comes from `pc` (`App.tsx:1178`). Tests: `paperclip-host.test.ts:33`, `manager-app.test.tsx:399-405`. |
| AC-5 | PARTIAL, RUNTIME-ONLY | The code follows D-5 (the shell only replaces its entry). A redundant `navigate` on first load may add a history entry, see F2. No end-to-end Back test exists. |
| AC-6 | RUNTIME-ONLY | The code adds no styles (D-8). I did not verify that the manifest or registered content scripts skip the Paperclip origin. I grepped `embed-bridge.ts` and `embed-content.test.ts` and found no Paperclip handling. No 1280 px or narrow-window test. |
| AC-7 | PARTIAL | `ThreadkeeperHostBridge.tsx:46-57` intercepts cross-origin anchors. `App.tsx:1116-1121` routes embeddable URLs to Browse and others to an ordinary tab. Tests cover only the parser (`paperclip-host.test.ts:23`), `openExternal` (`threadkeeper-host.test.ts:49`) and `embedTargetFor` (`workspace-state.test.ts:71`). The App handler branch has no test. |
| AC-8 | PASS-UNTESTED / RUNTIME-ONLY | The Paperclip frame is not a session slot or capture target. `messaging.ts:182,244` refuse messages from `frameId != 0`. I found no test of a refusal from a manager-origin child frame. The "no thread created after an hour" half is runtime-only. |
| AC-9 | PASS-TESTED | Shell side: `host.ts:20` checks source window and origin, `paperclipPath` checks the path; tests `paperclip-host.test.ts:5,14` and `paperclip-view.test.tsx:43`. Page side: `threadkeeper-host.ts:24,30,70,82`, which checks `source===parent`, origin allowlist, and hello origin before navigate. Tests: `threadkeeper-host.test.ts:15,22,29` and `threadkeeper-boot-channel.test.ts`. I found no `*` target origin and no handler that skips `event.source`. |
| AC-10 | RUNTIME-ONLY | No sign-in or session-survival test. Existing Chrome and Edge reports are untrusted pointers here. |
| AC-11 | PASS-TESTED (end to end RUNTIME-ONLY) | `PaperclipView.tsx:34-43` reloads at `lastPath`. Test: `paperclip-view.test.tsx:109`. |
| AC-12 | PASS-UNTESTED | `App.tsx:324` forces `threads` off the page surface, and the Rail renders only in the page branch. No test asserts "Paperclip" is absent from the side panel. `manager-app.test.tsx:378` is a snapshot only. |
| AC-13 | PARTIAL (rule builder PASS-TESTED) | `rules.ts:42-55` adds `excludedRequestDomains`. `background.ts:969-975` supplies the configured hostname. Tests: `workspace-commands.test.ts:493`, `paperclip-integration-contract.test.ts:35`. Header retention on a real response is RUNTIME-ONLY. The "provider headers still stripped" half is untested in the files I read; I did not read `embed-rules.test.ts`. |

## 2. FR scenario gaps

- **FR-1 edge (side panel and overlay):** implemented, no assertion.
- **FR-2 negative (document fails, panel within 5 s):** see F1.
- **FR-2 edge (6 session tabs, none put to sleep):** no test.
- **FR-3 edge (404 on the stored path):** there is no shell logic, and the spec says there is none. No test needed.
- **FR-4 edge (three links, Back twice):** no automated test.
- **FR-5, FR-6 edge (`target=_blank`), FR-7 edge (a `paperclip` thread opens in the view):**
  - FR-5: no tests at all (runtime).
  - FR-6 edge: the code leaves same-origin links to the browser. No test.
  - FR-7 edge: implemented at `App.tsx:724-730`, no test.
- **FR-8 (all scenarios):** runtime-only, no tests.
- **FR-9 edge (origin change moves the exclusion):** `SETTINGS_CHANGED` re-runs `hello` (`background.ts:1796`) and `installEmbedRule` compares the exclusion list. I did not confirm a test for this.

## 3. Findings, most severe first

1. **Major | AC-3, FR-2 negative, NFR "Recovery" | `extension/src/core/paperclip/lifecycle.ts:72`**
   - Expected: the status panel replaces the frame within 5 s of the server stopping.
   - Actual: while `running` the probe interval is 30 s. The only fast path is the page's `disconnected` message. That message depends on a live company connection existing and the host handshake having completed (`ThreadkeeperHostBridge.tsx:59`). An idle login page or a missing allowlist gives up to 30 s of a dead frame.
   - Fix: while the Paperclip view is active and visible, use a 5 s cadence. Make it a lifecycle option driven by `PaperclipConnection.tsx` `enabled`/`active`. Touch `lifecycle.ts` and `PaperclipConnection.tsx`.
   - Test: fake-timer lifecycle test that a stop is detected at or before 5 s while active.

2. **Minor, needs a runtime check | AC-5, D-5 | `PaperclipView.tsx:68-78`, `ThreadkeeperHostBridge.tsx:31`**
   - Expected: the shell adds no history entries.
   - Actual: the initial `navigation` state (request 0, path equal to `pc` or `/`) is posted as `navigate` after `ready`. The bridge calls plain `react-router-dom` `navigate(path)` under `BrowserRouter` with no same-path check, which probably pushes a duplicate entry on every window load.
   - Fix: in `ThreadkeeperHostBridge.tsx` use `navigate(next, { replace: next === pathRef.current })`. Alternatively, in `PaperclipView.tsx` skip the pending path when it equals `firstPath` on request 0.
   - Test: bridge test that navigating to the current path calls `replace`.

3. **Minor | AC-4 diagnosability | `PaperclipView.tsx:46`**
   - Expected: restore works, or the failure is visible.
   - Actual: an empty or wrong `PAPERCLIP_THREADKEEPER_EXTENSION_IDS` (for example after the extension ID changes) means no `ready` message. The shell shows "Opening Paperclip…" for 10 s and then the frame. Route sync and deep links silently stop working.
   - Fix: after the 10 s timeout with no handshake, show a one-line non-blocking note, or at least record it in diagnostics.
   - Test: view test with fake timers.

4. **Minor | AC-9 | `host.ts:11` vs `threadkeeper-host.ts:11`**
   - The shell's path validator allows a space (U+0020), while the page's validator rejects it. This is harmless today because the page filters first, but the two contracts diverge.
   - Fix: share one character class. Add a parity test over a table of paths.

5. **Minor | AC-7, AC-12, AC-2, AC-8, FR-6/7 edges | tests**
   - These behaviors exist in source with no test: the `App.tsx:1116-1121` branches, `App.tsx:724-730`, side-panel absence, 6-frame coexistence, and child-frame refusal.
   - Fix: add small unit tests in `manager-app.test.tsx` and `frame-stage.test.tsx`. Add a `frameId` case in `embed-gate.test.ts`.

6. **Minor | FR-5 | `PaperclipView.tsx:100-107`**
   - `onLoad` resets `ready` and re-shows "Opening Paperclip…" on every full-document load inside the frame. After the first load, a hard in-frame navigation can show the overlay for up to 10 s if hello is slow.
   - Fix: show the overlay only before the first `ready`.

**Event-stream fallback.** No defect found at source level.
- `company-live-events-stream.ts:19` applies `assertCompanyAccess`.
- It rejects restricted agent keys (line 26) and subscribes per `companyId`.
- It uses the same `visibleEvent` viewer filter and membership recheck as the socket (`company-live-delivery.ts`).
- Cleanup runs on `close`/`error`, and keepalive and server drain are handled.
- The client opens it only when the host is verified (`hosted-live-transport.ts:41,45-60,61-70`). It sends no tokens in the URL, and reconnect uses the existing exponential backoff capped at 16 s (`LiveUpdatesProvider.tsx:2474`).
- The "verified host" gate is client-side only. Server-side access equals ordinary authenticated HTTP, which is acceptable.
- The runtime proof of stream auth inside the frame is recorded elsewhere. I did not re-derive it.

**Security checks that held.**
- Both message handlers check origin and source window.
- The allowlist is a validated meta tag (`/^[a-p]{32}$/`, server-injected).
- An empty list disables the module, and an ordinary web page cannot match an extension origin.
- The security-header exclusion uses `excludedRequestDomains`, set only for the configured host. It covers every port on that hostname, and that breadth is documented in `background.ts:972`. Provider stripping is unchanged.

## 4. Top three improvements

1. Make the status panel appear within 5 s while the view is active (F1).
2. Stop the redundant first-load `navigate` and prove Back/Forward with an end-to-end test (F2, AC-5).
3. Add the missing tests and a visible failure for a handshake that never completes (F3, F5), covering AC-2, AC-7, AC-8, AC-12 and the 6-frame budget.
