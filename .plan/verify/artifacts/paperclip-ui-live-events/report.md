# Final UI host and authenticated live-events validation

The final coordinated UI scope passed **17 targeted files / 333 tests** and UI
TypeScript checking. The exact source hashes and raw red/green records are here.
The tests cover native search, current sidebar/plugin integration, current task
plugin tabs, native secret-reference status, the host boundary, boot buffering,
and all selected live-event consumers.

The authenticated frame first exposed a real native WebSocket boundary: under
the same normal UI login and company, an ordinary-page socket opened while a
socket inside the extension frame did not. Existing HTTP authentication worked.
The parent selected same-auth HTTP EventSource fallback for verified hosts only.
It preserves ordinary WebSockets, uses the same event processor and server viewer
policy, keeps one active channel, cleans up on scope/visibility changes, and
emits one connection-loss notification per outage until recovery. It makes no
bidirectional run-interest negotiation claim.

Full-document navigation then exposed an early-hello race. An origin/source/path
checked module listener now retains the latest legitimate hello while React boots
and across its effect remounts, plus only the latest pending valid navigation.
The normal host handler revalidates the message on attachment. The extension
consumer separately rearms bounded hello retries for each iframe document load.

Final real-browser evidence is sealed under
`.acceptances/paperclip-merge/round-13/` (Chrome for Testing 153) and `round-14/`
(Microsoft Edge 157). Each has **9 passed UI journeys and 1 blocked native
host-permission consent case**. Both proved actual iframe sign-out/sign-in,
authenticated SSE task delivery without a document reload and an active app
service worker. Original screenshots, DOM readbacks, videos, timestamped video
samples, the exact manifest fixture and source hashes are retained. The Neo
checker reports valid structures, nine complete evidence cases and blocked
overall acceptance; sealing is not deployment approval.

The test manifest pregranted only localhost host access, kept the manifest key
absent and was restored byte-for-byte. The unsupported native permission prompt
remains explicit. This scope does not establish real provider actions, model-key
transfer, login-service installation or live deployment/library continuity.
