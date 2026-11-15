# Independent spec review — fix-all cycle, review 1

Reviewer: `final_spec_review`, independent of every implementation author. Read-only source review; the only authored file is this review. Review captured at 2026-11-15T04:23:01.837112+00:00. Repository HEAD is `79589c00e99453352b0aafe1c8b5582af42284ba` with the uncommitted working source identified by SHA-256 below.

## Verdict

**PASS for the new source-change scope.** No concrete Blocker, Major, or Minor source defect remains in the reviewed repairs and screenshot-directed layout changes. This is not a full-plan completion verdict or a claim that browser acceptance passed. Fresh browser evidence is still required for direct entry, zero-delay input restoration, layout geometry, narrow control reachability, and the enlarged live viewport.

**Formal plan completion remains incomplete.** Original AC-10, the zero-native-message AC, native consent, broad Paperclip qualification, real providers/model keys, helper/launchd, MV3 suspension, and live-library continuity retain the limits recorded in `.plan/verify/fix-all-cycle.md`. The new cycle does not waive them or convert historical failed/blocked checks into passes.

## Requirement and repair assessment

| Contract / prior finding | Source assessment |
| --- | --- |
| N-2, direct Threads startup | `App.tsx` retains the shell entry in `fusedEntryRef` while the first eager page reports a different/null slot. It ignores stale mismatching slots, obtains the company prefix from the route, requests the matching route, and releases the entry guard on the requested slot. Tests exercise the actual real-App path with home/empty-slot startup, delayed company prefix, subsequent normal Paperclip navigation, and explicit Paperclip entry. This fixes the old test's injected-success premise. Browser sequencing remains pending. |
| Palette immediate-click defect | `threadkeeper-overlays.ts` excludes semantically closed Radix content/backdrops and wrappers whose branches are closed. Its close-batch exception performs a fresh complete blocker scan before reporting false instead of waiting a frame. Independently open siblings/backdrops and unmarked content remain blockers. Ordinary bursts remain coalesced. The real Radix test retains exit nodes while asserting closed state; it does not remove backdrop guards. Actual cross-document input order requires the strict browser probe, with all attempts retained. |
| Title plus mode switch | The detail title and `ThreadModeBar` are siblings in a nowrap flex row. The title can truncate; its full value is retained in a tooltip. The mode switch remains the existing accessible segmented control and compacts its labels at narrow container widths. |
| One controls row | Category, lock, workflow status, original/resume, handoff, optional Still, workspace pin/Browse, and Delete share `tk-detail-controls`. The row does not wrap and supports horizontal overflow. Category/status widths are bounded. Shortened/icon labels keep full accessible names/tooltips; the lock retains a native labeled checkbox. Existing callbacks and pin state remain wired. Geometry and actual keyboard scrolling remain browser claims. |
| One Sessions list | Full-page App passes one `ListPane` to `Rail.sessions` and renders only `DetailPane` in the main Threads columns. The complete index replaces the preview while Threads is shown. Other views use the existing Sessions preview. No second view switch is restored in fused mode. Sidepanel keeps its original list path. |
| Search, filters, group/sort, selection | ListPane retains its original query, grouping, sorting, filter, view-mode, bulk-selection/action and row callbacks. Less-used controls use a compact disclosure. Projects/queues remain in a named disclosure. Compact rows preserve provider/account, selection, live/run/workflow status, search excerpts and independent checkboxes. |
| Navigation state and narrow access | Rail keeps the index mounted while hidden on collapse/view change, preserving Ask draft and local disclosure state. The search shortcut opens the rail/drawer before focusing; the drawer closes on row choice. Main detail stays available at narrow sizes, including its empty state. Tests cover mounted-draft identity, collapsed/narrow focus and the one-index composition. |
| Ask formatting | The multiline textarea occupies the form width; hint and submit action live below it. Four starting rows replace the cramped side-by-side field. Existing retrieval, disabled/loading/error/answer/citation flow is retained. Narrow overflow and readable visual size need the browser screenshots. |
| N-4, refusal-test fidelity | Boot-channel tests use a bare spy consumer to prove refusal before hello and for wrong origin/source; they no longer rely on downstream host guards. Real bridge tests register a slot and inspect actual placement plus palette effects, with accepted-message positive controls. Host origin/source/payload validation is unchanged. |
| F-7, cross-package drift | The contract test runs actual parser, reducer, router, host and registry modules and the source-selected placement/open-view effects for Browse, Threads and Session board. It follows PluginPage's extracted component import. Its documented isolated mutation receipts demonstrate each former mapping blind spot. The plugin budget assertion imports the actual extension margin instead of duplicating 1500. N-1 runner wiring remains present. These checks establish contract values, not React scheduling. |
| Missing unresponsive status | `ThreadkeeperSlot` observes the existing validated placement attribute. It displays the exact message after two seconds without its matching placement, clears on acknowledgement, restarts after loss and cleans up on unmount. It grants no authority and does not itself enable transparency. PluginPage only selects this path for the verified host and matching first-party route. |
| Document reconciliation | The supplement states the screenshot requirements without renumbering original ACs. The cycle record preserves historical failures, unresolved formal gates and inferred product direction. Hooks/test-command registration is described independently of actual execution. |

## Validation examined

I inspected source and targeted regression/mutation tests, plus the actual author receipts in `/tmp/tk-fix-all/host-overlays/report.md` and `/tmp/tk-fix-all/contracts-f7-report.md`. Those receipts report 55 focused UI tests and 17 guard/contract plus 110 plugin tests respectively; these are author-run results, not independent reruns by this reviewer. I also inspected the actual real-App direct-entry tests and the sidebar/header regression tests. The lead's aggregate runs and browser worker are active and own final validation.

The only command I ran for validation was scoped `git diff --check` over reviewed implementation locations; it exited 0. I did not build, run a browser, exercise a real provider, create a commit, or open a PR. No source edit or test weakening was made by this review.

## Findings and next action

No new concrete source finding. Proceed to independent quality review on these same source hashes, then combine its result with the fresh browser/aggregate-test evidence. If a browser failure causes a source repair, invalidate this review only for the changed inputs and review that delta before claiming final source coverage. Keep the formal gate limits separate from the source verdict.

## Reviewed source identity

SHA-256 values identify the actual bytes reviewed; a commit hash alone would not identify this dirty snapshot.

| Path | SHA-256 |
| --- | --- |
| `extension/src/entrypoints/manager/App.tsx` | `440f4b5ca18602b2d9fc5c0001c72c7de881d4c416f8f65ff2b8312e5f32189e` |
| `extension/src/entrypoints/manager/PaperclipFusion.ts` | `cac9d70ceddee45a48c5b4607f9e38511b2ba4454c8686decf4d358c52a7a848` |
| `extension/src/entrypoints/manager/PaperclipView.tsx` | `36e4303ddc74083467b43d404c4a30aa69ae4a6afc0ffd874e13a7c568871e2c` |
| `extension/src/entrypoints/manager/threads/DetailPane.tsx` | `c3eb4da2feaf5ad607e47035c591356f15c24445ff1232a068af0333ced535f9` |
| `extension/src/entrypoints/manager/threads/DetailWorkspace.tsx` | `cfb6990a8b678516e9f939b85cbbcc8d78a0fc7119a43742aee278f5c336ea6e` |
| `extension/src/entrypoints/manager/threads/ListPane.tsx` | `2dd5603ad9d1b2394840d2c4ddbc10e9a684b8ead94bd911b5a23bec0d6e037c` |
| `extension/src/entrypoints/manager/threads/ThreadRow.tsx` | `72d7ae1636d869fc5169209aa8802da6fa38b5f8173f41a7b7aa701154446398` |
| `extension/src/entrypoints/manager/AskPanel.tsx` | `0b4b4e703bf55657e5f197a394d00fdecc348da4b55c43f7adceea2d84e7515c` |
| `extension/src/entrypoints/manager/shell/Rail.tsx` | `2af651ea4ab5ffb36e59827459af876d72079f91fbfad755ef041d5b6f4b65f8` |
| `extension/src/entrypoints/manager/shell/SessionsNav.tsx` | `ba1420618f8198d2e950ada3ffcc5f061e786648554f6956b02bd2e8794cf25d` |
| `extension/src/entrypoints/manager/shell/icons.tsx` | `01f919be4973daf38c74e49230be7442874815a865e314190aaf31eb1f490154` |
| `extension/src/entrypoints/manager/styles/10-shell.css` | `47f64f74ba63ad25a93d8ee8f21015cf2cd8f83fe2e9ff00cac682da7c1da18f` |
| `extension/src/entrypoints/manager/styles/30-threads.css` | `d71c1bf204a6125e7e4049d63052ac69f24ba35b1fef64c3624a8be47ed32fe2` |
| `extension/tests/unit/paperclip-fused.test.tsx` | `65611c6ab7968350d25aa3d6a9622e47eebf38aa05b22bb8fee77a0db53c55c8` |
| `extension/tests/unit/threads-sidebar.test.tsx` | `ef47efb9c5c08dd122d695b52ec85dc85ad66066ba9a357b40519b7607b59341` |
| `extension/tests/unit/threads-view.test.tsx` | `6b088a7877914113ab0052381aea91e2d943a1660fbc422a28bced41ff396af4` |
| `extension/tests/unit/manager-app.test.tsx` | `1175a95a9ab2818341916be22bbe12654013db8527be6dae7e941680677da294` |
| `ui/src/lib/threadkeeper-overlays.ts` | `7f6cb5393f3de18ce6c8bd6c3ed3d370956e3bb89951c768e8dfa17d3e03084d` |
| `ui/src/lib/threadkeeper-host.ts` | `5af300657598c6137d5fda95a6b3003993cdf542fad26f7c596e15bdbaee825f` |
| `ui/src/lib/threadkeeper-host-fusion.ts` | `a98ccf48d3f78bdc82e1e9d204d7b612b304cabe15d8dfd74d68a80b2df682df` |
| `ui/src/lib/threadkeeper-host-slot.ts` | `bf884a9c952f53d584e33880f3736a255b48348d7b17a17594a1f51311f33fc2` |
| `ui/src/lib/threadkeeper-overlays.test.ts` | `210a61ba51a8e3d0f450fa638f522827985c43138f444a7922dc90cdb3613f43` |
| `ui/src/lib/threadkeeper-host-fusion.test.ts` | `8e014e16a9b15590061f5048db7cb8b3314969d707d89810b4ae165ce32c5ec1` |
| `ui/src/lib/threadkeeper-boot-channel.test.ts` | `88056ba4bcb0e77fa8b115ca40e7b72a272121a9254ba447a9d64e2ac9fd38ef` |
| `ui/src/lib/threadkeeper-host-bridge.test.ts` | `1961f910300c8998437a9293101799485e157e1ddee60d9bd2e2fbc9114bf38c` |
| `ui/src/components/ThreadkeeperSlot.tsx` | `60472d7a0925555bf8fc831331f05c93857c7231914b7dd5ef6d345fdfaa2237` |
| `ui/src/components/ThreadkeeperSlot.test.tsx` | `8974fa8cc3d2265dc6f257a57fc5c2648b94a9185e6a4e5bff98348cb3e536e5` |
| `ui/src/pages/PluginPage.tsx` | `216731e1cc9882b9200033eb30eac588f319f62533faa00c2acf4b7b431ce92a` |
| `ui/src/pages/PluginPage.test.tsx` | `e346a541ede81f11ed3e0cc7f8813ae20fdcf6b43b0388e242eff9c8a2dddffc` |
| `scripts/threadkeeper-contracts.test.mjs` | `845ade9eba6fe63ceff108a899a6d3a64953375d82d6460e1e2d85af27babb5f` |
| `packages/plugins/plugin-browser-sessions/tests/service.spec.ts` | `ba2c50b6c1882a01879b51f1b3fd8230b5619b1cbcc9e2a26e7231e383782b47` |
