# Paperclip UI integrated validation

The original host/search evidence remains in `../paperclip-ui/`. This supplement
covers runtime-driven integration repairs and native credential controls.

- `CoordinatorSidebar` now mounts the existing company-scoped plugin sidebar
  outlet. This is the current default app sidebar; the older Sidebar components
  already had outlets. Real browser evidence shows Browse, Threads and Session
  board beneath its native Chat, Tasks and Inbox entries.
- The native company plugin settings page reuses `PluginConfigForm` and its real
  secret-reference picker for browser-sessions. Metadata-only company-scoped
  status distinguishes Linked, Not linked and Secret missing, including after
  a company switch. No secret value is resolved by these controls.
- Native company WebSocket error/close emits one generic connection-loss event
  per socket. The authenticated optional host relays it to the extension without
  adding a poller. The paired extension consumer is owned by the extension UI
  worker. An actual controlled server stop in browser round4 rendered the offline
  panel **390 ms** after native company socket closure; the original execution
  and video remain in `.acceptances/paperclip-merge/round-4/`.

Actual supporting checks: nine UI test files, **116 tests passed**, and UI
TypeScript check exit0. Raw logs and exact source hashes are retained here.
Red/green logs cover the new native sidebar seam, missing-secret/company boundary,
and native socket-disconnect reporting. Initial native settings mount tests also
failed before implementation and then passed.

Product acceptance is separate and still running. Existing browser rounds retain
failed fixture attempts and discovered source repairs; this test-suite pass does
not certify the whole merge, authenticated browser behavior, real provider actions,
fused layout or final cross-browser acceptance.
