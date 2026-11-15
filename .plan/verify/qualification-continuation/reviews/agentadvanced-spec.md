# Independent spec supplement — CodeMirror test fixture

Reviewer: `final_spec_review`, independent of the author. Captured 2026-11-15T08:04:27.702352+00:00. Scope: `ui/src/pages/AgentAdvancedTab.test.tsx` only, on HEAD `48275586efb8641ab8e763d378e6d5e676dc6681` plus working SHA-256 **`f21471c786f8165a6c0041b4d40fae44929cfece38cbbad256a412f8ea054699`**.

**Technical verdict: PASS. No concrete source defect found.** The prior five-file continuation review remains unchanged.

The file-local `document.createRange` spy calls the captured real method and adds only the missing `getClientRects`. It returns an empty DOMRectList with length0, itemnull and a correctly typed empty iterator. The actual Range behavior and actual CodeMirror editor are retained. An empty list is appropriate to jsdom's layoutless document; it does not invent visible geometry or establish browser layout correctness.

The new regression first verifies the required list interface, then calls the real mounted EditorView's `coordsAtPos(1)` and requires null. The retained measurement RED throws the exact getClientRects TypeError on that path, so this positive check exposes the fixture failure rather than merely asserting the shim's presence. All seven earlier save/input/editor tests retain their original bodies, assertions and relative order. No tests are skipped, no application snapshot changes, no error handler/log suppression, and no production editor substitute was added.

Cleanup unmounts the component before `restoreAllMocks`, allowing the real editor to cancel its own work while the range fixture remains available. The spy is restored after every case; no global Range prototype or shared test setup is changed. The existing ResizeObserver fixture is unchanged.

I inspected the Node24 measurement RED (one failure/seven passes), GREEN and final logs (eight passes), and the typecheck attempts. The first iterator annotation produced a type error; current source uses an Array iterator and the final typecheck log has no diagnostics. These are author-run checks, not independent reruns by this reviewer. No CodeMirror per-test stderr/unhandled-error report remains in the accepted targeted run. The existing Vite config-loader warning is still retained; this review does not describe the entire process stderr as empty.

My validation consisted of source/diff reading, a seven-test-name/order comparison, the final source hash and scoped diff whitespace checking (exit0). I did not run a broad suite, browser or build, or modify source.

This fixture repair invalidates only the affected earlier file's broad-run evidence. Preserve the original broad-run unhandled errors and attach this current targeted replacement; unchanged-file passes may retain their original provenance. Full-suite/CI qualification and browser geometry remain separate claims.
