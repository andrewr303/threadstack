Threadkeeper browser verification round-43: 156.0.8078.4

Raw browser counts: {'pass': 16, 'fail': 0, 'not_run': 0}. These are observations, not full-plan completion.

Browser: 156.0.8078.4 (dark). Extension: offhmjmiccalfahcdkdhcddbnealijkm. Build: 0.5.0 (build 20261115.054541-a44541df70). Runtime: existing Playwright runner in a disposable profile.

The source server and database are isolated on loopback3217/55487. The synthetic conversation is served locally and has no provider account. A test-only manifest grants loopback and that synthetic provider origin. The original manifest restoration receipt is in results.json.

Outcomes:

- **pass — setup**: Connected to http://127.0.0.1:3217 through Settings; 40 synthetic threads seeded. ([raw receipt](setup.json))
- **pass — fused-direct-entry**: Opened surface=page&view=threads without visiting the Paperclip view; fused Threads in 573 ms (shell within 1 px of slot). ([raw receipt](fused-direct-entry.json))
- **pass — fused-palette**: Meta+K from a focused row opened the palette (frame raised, on top, view visible under it by luminance correlation); typing reached it; Escape closed it; a row click right afterwards worked with and without a settle. ([raw receipt](fused-palette.json))
- **pass — fused-mobile-entry**: Fresh Threads entries at700px and480px fill a nonzero mobile content slot. The single Sessions drawer searches and opens the matching chat; the main pane remains the selected conversation. ([raw receipt](fused-mobile-entry.json))
- **pass — fused-entries**: Sidebar lists Browse (/THR/browse), Threads (/THR/threads), Session board (/THR/session-board); a real click on each reached its path and the matching shell view. ([raw receipt](fused-entries.json))
- **pass — fused-in-place**: Threads view lies inside the slot with Paperclip sidebar on top at its entries; one switch group (Paperclip nav) and none in the shell; same view node and same frame timeOrigin after Tasks and back. ([raw receipt](fused-in-place.json))
- **pass — fused-placement**: 8 placements measured (viewport resizes, sidebar drag, collapse/expand); max edge delta 0 px. ([raw receipt](fused-placement.json))
- **pass — fused-layering**: Attribute: threads on Threads, removed on Tasks, threads again on return, browse on Browse (first set after 2 ms). ([raw receipt](fused-layering.json))
- **pass — fused-input**: Row click selected "Fused seed thread 4" (index 3); wheel scrolled the list 0 -> 700; sidebar click reached Paperclip (/THR/issues). ([raw receipt](fused-input.json))
- **pass — single-session-sidebar**: The existing Sessions rail contains the only thread index. Search selected the matching chat, filter/sort/group controls opened there, grouping changed, and Select all remained usable. ([raw receipt](single-session-sidebar.json))
- **pass — compact-chat-header**: At 1600, 1280 and 700px widths, the title shares one row with view tabs and the controls remain on one row. The live synthetic conversation has at least 580px of vertical space in each 900px viewport. ([raw receipt](compact-chat-header.json))
- **pass — sidebar-ask-layout**: The Ask question field spans the Sessions sidebar at desktop and narrow widths, keeps four readable lines without a scrollbar for the two-line draft, and places its enabled action below the field. ([raw receipt](sidebar-ask-layout.json))
- **pass — fused-notice**: Toast "Created THR-22Open THR-22" appeared (overlap with shell: yes), was on top, view row click selected index 6, dismiss button click removed it. ([raw receipt](fused-notice.json))
- **pass — fused-jank**: Idle 5 s: frame 0 long tasks (0 ms), shell 0 (0 ms). 20 cycles in 817 ms: frame 0 (0 ms, max 0), shell 0 (0 ms, max 0). ([raw receipt](fused-jank.json))
- **pass — fused-fallback**: The ordinary tab at /THR/threads shows the heading "Open this in Threadkeeper" and no slot. ([raw receipt](fused-fallback.json))
- **pass — fused-offline**: Stopped the owned server (pid 11971); Threads stayed mounted with the shell rail and switch (Browse/Threads/Dashboard/Paperclip); after restart fused mode resumed on /THR/threads (same view node: true). ([raw receipt](fused-offline.json))

Evidence inspection:
- Inspected every original screenshot state through three labelled contact sheets; opened full-size standalone1280/700, Tasklinks dialog and narrowAsk originals. Title/tabs and controls share rows; the native dialog is settled/opaque; the question field is readable and the synthetic chat labels are UTF8.
- Inspected the original browser video through decoded samples at0,2,4,... seconds covering the whole recording, including palette, navigation, mobile layout, dialogs, outage and return. Sparse sampling cannot exclude a one-frame flash; no such absence is claimed. Native input/timing assertions use the separate original JSON receipts.
- The raw zero-delay loop records row1selected/focused and an actually focused/opaque/raised palette before Escape. No wait occurs between Escape and the native click. Outside-dismiss retained row1 during350ms of frame observations.
- The fixture watcher expired during the previous round42outage attempt; that failure and restartreceipt are retained. This fresh round exercised actual owned shutdown/restart successfully on unchanged product source.
- No real provider account, model key, native consent prompt, helper/launchd, live deployment or service-worker suspension is qualified here. One provider-shaped document is explicitly synthetic and served locally.

Untested surfaces: real provider accounts/model keys, native host-permission consent, helper/launchd, live-library deployment and service-worker suspension.

Supporting quality: safe extension and UI production build receipts are retained under /tmp/tk-fix-all. Build/typecheck success is separate from the browser outcomes.

The lead should resolve any failed assertion, rerun affected outcomes in a fresh round, and inspect the recorded media before handoff.
