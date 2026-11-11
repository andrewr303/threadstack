# Workspace and retrieval continuation

Local implementation and supporting checks are complete. Acceptance coverage: **4 passed, 2 blocked, 0 failed, 0 uncertain, 0 not run**. Real signed-in provider use and authenticated model requests remain blocked; this report does not establish production compatibility or better hosted-model ranking quality. The optional native Mac helper was not run.

The existing worktree already contained Browse, Threads, Dashboard, accounts, cookie bridges, coding-session facts and the Voyage endpoint selector. This continuation preserved those changes and completed compact filters, integrated explicit-submit hosted semantic search, hardened provider/vector/rerank validation, preserved legacy Voyage key routing, and repaired a browser-reproduced narrow navigation defect. No commit, push, deployment, personal-data import or live model request was performed.

## Browser outcomes

The selected runtime was Synara's integrated browser, under the installed `acceptance-neo@acceptance-neo-local` workflow; BrowserOS neo tools were absent. The target was `http://127.0.0.1:4317/manager.html?surface=page&seed=1`, an existing local preview server with synthetic library data and stubbed Chrome APIs. This is real rendered application UI, but it is not a running extension. It cannot verify cookies, native messaging or provider frame behavior.

- **workspace / R1:** Threads, Browse and four-pane Dashboard were rendered and inspected. [Threads](assets/filters.png), [paused account tab](assets/browse.png), [Dashboard](assets/dashboard.png).
- **filters / R1:** Selected Claude Code, collapsed the active filters, verified `Filters · 1`, hidden provider field and four matching rows, then reopened and cleared. [Screenshot](assets/filters.png).
- **endpoints / R2:** Selected legacy Voyage with the Voyage reranker, reopened Settings and observed it persisted. Selected MongoDB under Voyage, then explicit Atlas with EU geography, reopened Settings and observed both values. No key entered; Test and Rebuild were not pressed. [MongoDB selector](assets/endpoint.png).
- **narrow / R3:** The requested 800x800 viewport initially converged, then the host settled to **600x754 CSS pixels**. Inspected the drawer and [narrow Settings](assets/narrow-settings.png). Escape initially failed because the window handler stopped propagation before Rail's document listener. [Preserved failure](assets/escape-failure.png). The fix retains menu/dialog priority, then yields to an open drawer. After rebuilding, Escape closed the drawer; the document had zero horizontal overflow. [Repaired state](assets/narrow-fixed.png).

[Original execution receipts](assets/browser-execution-final.json) contain actions, endpoint persistence, original and final build diagnostics, and the failing/passing Escape readbacks. [Bounded console log](assets/browser-logs.json) contains host `navigator.modelContext` deprecation warnings; it is truncated and is not a claim of exhaustive console coverage. No recording was required and no animation/continuous liveness claim is made.

Initial screenshots reported build **20261111.003122-0d82449** in Diagnostics. The final rebuilt UI reported **20261111.003759-0d82449**, matching its preview manifest and bundle. Both builds are at HEAD `0d82449` plus uncommitted work in this branch. Earlier screenshots retain their original capture times and build identity. The final changes affect search behavior and Escape handling; the earlier filter/settings/Browse/Dashboard pixels remain applicable. The repaired drawer screenshot comes from the final build. No sealed prior report was changed.

## Supporting quality checks

`npm run typecheck`, `npm run build`, `npm test -- --reporter=dot`, and `git diff --check` passed. The final unit run has **1,214 passing tests in 69 files**. [Final suite](assets/unit-tests.log), [initial suite with 17 manager failures](assets/baseline-tests.log). The initial failures were resolved by reviewing and refreshing intentional redesign snapshots, correcting theme/visible-control expectations, and checking page-only workspace registration. The new Escape regressions cover inner dialog, account menu, drawer and checked-row priority. Unit output retains existing React test `act` warnings; those are not browser errors.

Provider tests validate complete unique embedding indexes, finite vectors and consistent dimensions, complete unique finite rerank scores before caching, selected endpoint isolation, key migration, cancellation and timeout. Search fixtures cover account/code scope, stale/foreign/orphan vectors, privacy changes during a request, superseded search completion and local fallback. No API key or generation provider was changed.

[Offline retrieval evaluation](assets/retrieval-evaluation.json) compares the frozen manager baseline with the current local first stage: recall@5 **0.885**, recall@10 **0.935**, MRR **0.870**, nDCG@10 **0.871** for both. This demonstrates local ranking parity on these synthetic labels. The added hosted query path and correctness fixes are not evidence of improved live relevance. [Focused retrieval log](assets/retrieval-tests.log).

The endpoint/key and request contracts were checked against the [MongoDB API overview](https://www.mongodb.com/docs/voyageai/api-reference/overview/), [embedding API](https://www.mongodb.com/docs/api/doc/atlas-embedding-and-reranking-api/operation/operation-createtextembeddings) and [rerank API](https://www.mongodb.com/docs/api/doc/atlas-embedding-and-reranking-api/operation/operation-rerankdocuments). The requested retrieval integration skill's validator accepted an illustrative offline fixture contract; no Atlas database/index is used or deployed by this local extension.

## Remaining live checks

Reload the unpacked extension from this worktree's `.output/chrome-mv3` for signed-in provider testing: send, stream, upload, sign-in redirects and account switches across each realm. Existing earlier Chromium checks used local provider-host stand-ins and were not repeated or relabelled here. Other site storage remains shared between accounts, and switching cookies changes ordinary tabs too; simultaneous accounts require the optional separate-profile helper.

For model testing, choose the endpoint matching the issued key, grant that host from Settings → Test, and verify embeddings/reranking before rebuilding vectors. MongoDB geography keys require their matching host. Existing Voyage keys lacking an endpoint retain the legacy service. Rollback is On-device only plus Reranker Off; no transcripts or prior vector spaces need deleting. See [architecture](../../../docs/architecture.md) and [Mac helper setup](../../../docs/mac-helper.md).
