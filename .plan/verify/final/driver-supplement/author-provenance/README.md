# Driver-only author provenance supplement

The sole post-review change is the nine-line optional `TK_PAPERCLIP_READ_HOLD`
block. It was added at 2026-11-14T07:52:11.838731+00:00, after SPEC round3
(07:37:40) and QUALITY round2 (07:48:28). It requires the real UI pairing case
to have passed, writes a nonsensitive ready marker, waits at most five minutes for
the authorized agent-read fixture to finish, then reaches the existing browser,
profile and manifest cleanup. It changes no product, dependency or bundle code.

Current frozen SHA-256: `408bff8a995af3b3248fe0b637b092d3501f829d36ad8b9cfa1107554d0a7039`.
Reviewed checkpoint SHA-256: `525689347e1863abbf62e019ecc33a71da720d7b1abaf9db10958e50c2010b5e`.

`reviewed-driver.RECONSTRUCTED-from-current.mjs` is explicitly a retrospective
reconstruction, not an original capture-time archive. Removing only the logged
hold block from current source produces bytes that match both independent saved
review hashes exactly. The patch records the complete delta; the current snapshot
is a new source archive made for this supplement.

Sealed rounds13/14 ran before the hold addition and used the old pre-hold driver,
based on the author edit chronology and matching later reviewed checkpoint.
Their original execution records did not store a driver SHA, and their sealed
production-source hash inventories exclude this driver. This supplement therefore
labels the historical driver hash as reconstructed rather than pretending it was
captured at execution. It leaves all sealed files unchanged.

Rounds15/16 used the hold-enabled driver: both original execution records contain
the new ready/done hold events. Their capture-time driver hashes were also not
recorded; the association with the current hash is an author chronology attestation,
not a newly manufactured original record. The final successful process-agent proof
is owned and recorded separately by the service worker agent.

No driver or sealed report was edited by this provenance task. The requested
ordered driver-only SPEC then QUALITY supplements can review the current frozen
source and this exact nine-line delta without reopening product implementation.
