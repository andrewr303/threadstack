Archive qualification result

The two assigned test files pass unchanged on Darwin/Node v26.13.0. No repository source edit was necessary or made by this task. The remaining failures require external platform capabilities; no guard was weakened or skipped in the complete suites.

| Check | Observed result | Exact evidence |
| --- | --- | --- |
| remote-workspace-migration.test.ts | 207 passed, no skips | [Current complete run](owned-current.log) |
| remote-workspace-snapshot-archive.test.ts | 122 passed, no skips | [Current complete run](owned-current.log) |
| retained-provider-pack-source.test.ts | 28 passed, 6 failed, no skips | [Complete suite](retained-pack-complete.log) |
| Native skill long-path cases | 2 failed; 18 other cases not selected | [Targeted reproduction](long-path-red.log) |
| Imported production extraction probe | Exit 1: BSD tar lacks --delay-directory-restore and GNU identity | [Platform details](platform-details.json) |
| Exact 1,185/1,199-byte relative paths from short /tmp root | Both ENAMETOOLONG; PATH_MAX=1024 | [Short-root reproduction](platform-short-root.log) |
| Final bounded integration check | PASS, no recorded input drift, owned source diff empty | [Receipt](lead-integration-check.json) |

Revision: `48275586efb8641ab8e763d378e6d5e676dc6681`. [Source hashes](sourcehashes.json), [commands and exit codes](commands.md), [earlier evidence hashes](previous-evidence-hashes.json), [cached tar search scope](cached-tar-search.json), and [preserved security assertions](preserved-security-assertions.json) are retained beside this report. The earlier complete-file pass is superseded by the current run because shared test setup changed during it. Test totals across repeated/overlapping runs are not additive.

Archive qualification findings

The owned archive and migration tests do not use GNU tar. Their historical
full-run failures were deadline failures: two archive cases took 15,100/15,055ms,
and four migration cases took 16,221–19,882ms against a 15,000ms server timeout.
The saved handoff already reported focused passes without changing those cases.
Fresh exact-file coverage passed all 329 tests (207 migration, 122 archive),
exit 0 in 226.808s, with no skipped cases. The shared setup-supertest.ts changed
during that run, so owned-before.json explicitly records different before/after
setup hashes. It is an observed pass, not final-setup qualification. The two
exact files were rerun as owned-current with the new setup: 329 passed, zero
failures, zero skips, exit 0 in 148.143s. All 14 recorded source/config/lockfile
hashes matched before/after and at the final bounded integration check; the
owned tests and archive production module have no diff. These results remain
separate from the earlier interrupted full run (exit 130, unqualified).

The missing GNU tar prerequisite belongs to retained-provider-pack-source.test.ts,
outside the owned source files. A fresh synthetic retained-pack upload fails at
provider-pack-upload.ts:54 with runner_remote_provider_archive_transport_unavailable.
The exact production probe imported by platform-repro.mjs exits 1. BSD tar 3.5.3
rejects --delay-directory-restore and does not report GNU tar. zstd, sha256sum,
and cut are discoverable. PATH has no gtar; the bounded task-directory and
Homebrew GNU tar path search found no tar/gtar candidate. No binary was installed
or substituted. Prerequisite: provide a real compatible GNU tar binary as gtar
for the existing test fixture, or run the unchanged suite on a host where GNU
tar is tar. Production extraction needs the exact options in
provider-pack-extraction.ts, including zstd and delayed directory restoration;
the correct fix is not removing its capability gate.

Both native-skill-library-tools.integration.test.ts long supporting-path cases
reproduce ENAMETOOLONG at skill-package-files.ts:135. The paths are 1,185 and
1,199 bytes before the package staging prefix. On this Darwin host PATH_MAX is
1,024. platform-repro.mjs reproduces both from a short /tmp/tk-lp-XXXXXX root,
then removes only that owned directory. This disproves a short-temp-base-only
fix. The test requires the returned reference path to exceed 1,000 characters;
the actual package staging prefix alone makes even a barely qualifying path
too long. Do not reduce segment counts or weaken that assertion to obtain green.
Run those unchanged cases on a filesystem/API with sufficient absolute path
capacity (normally the Linux qualification host). If product support for these
lengths on macOS is required, the owning module needs a separately reviewed
confinement-preserving path I/O design; it cannot be repaired within these
assigned tests. No production change is proposed solely to accommodate this host.

The archive suite's intentional ENAMETOOLONG error-redaction test is separate:
its single 440-byte SYNTHETIC_PRIVATE_NAME component remains invalid with a short
parent. Its expected malicious-path rejection must remain unchanged.

Debugging used the requested /Users/andrew/dev/Plugins/ult-debugger router,
debug-typescript and debug-infra. The initial Vitest pretty output did not parse
as a V8 trace in ultdbg (triage exit 1); this is not test success. A captured
native filesystem stack from the short-root reproduction parses with high
confidence in short-root-triage.log. The platform reproduction's exit 0 means
it successfully asserted the expected failures, not that the product tests pass.

The complete retained-pack suite was also run without filters: 28 pass, 6 fail,
zero skips. Five failures are capability-probe refusals and one is the test's
forbidden directory-fallback assertion after archive installation is unavailable.
Its escaping inner-tar path, invalid code digest, escaping/unknown hardlink,
unsafe-cache-directory and refused-transport target-preservation cases passed.
This is partial security coverage with a failing suite, not Linux qualification.
The retained-pack and native-skill failure reproductions ran before the shared
setup change, with stable before/after hashes in each receipt. Their product
sources are unchanged. No pass on the new setup or a Linux host is asserted for
those external prerequisites; the repeatable standalone platform probe and
short-root reproduction establish this host's specific limitations.

No repository source has been edited by this task. No full-repository suite,
build, remote action, provider login/generation, real workspace archive, or
credential read was used. No host-level HOME or CODEX_HOME assignment or
configuration change was made. Initial tests inherited an already-set CODEX_HOME;
the old setup conditional left it set. The new shared setup, changed outside
this task, assigns a temporary synthetic CODEX_HOME inside each Vitest worker
and registers cleanup at worker exit. No existing home is rewritten. CI
startup/zero-job diagnosis and broad qualification remain outside this task's
execution scope.
