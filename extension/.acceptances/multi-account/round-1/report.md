# Threadkeeper multi-account verification

Live Cursor sign-in is blocked on two authorized test identities. The packaged Chrome fixture passed three user journeys and all 48 assertions. It used disposable HeadlessChrome 156 at 1440×900, build `20261123.201535-5adc60f8a`, and local stand-ins for Claude and Cursor. The test-only manifest pre-granted the Cursor hosts. BrowserOS Neo was reachable in its own profile, and the in-app browser reported a shared Electron webview. Packaged testing used the repository’s Playwright runner in a disposable Chrome profile.

| Journey | Result | Evidence |
|---|---|---|
| Add a second Cursor account | Pass with fixture | [Duplicate identity warning](assets/06-cursor-duplicate.png), [signed-in second account](assets/07-cursor-second-account.png) |
| Move a saved account to another Threadkeeper tab | Pass with fixture | [Move control](assets/04-move-account.png), [account loaded in the second tab](assets/05-account-after-move.png) |
| Keep Claude embedded and browser-tab sign-ins working | Pass with fixture | [Claude accounts after reload](assets/03-dashboard-after-reload.png) |
| Complete Cursor’s actual sign-in flow | Blocked | Requires a test profile with two authorized Cursor logins |

The [runner transcript](assets/profiles-e2e.log) records the original account returning in Chrome, refusal of premature completion, and recovery after closing the first sign-in tab. It also records the first workspace pausing the moved account and leaving the other one visible. Earlier harness attempts stopped at an outdated Dashboard selector, a selector that matched both the hidden and visible panes, and a legacy host permission prompt. Those logs are retained in the attempts folders.

The extension typecheck and packaged build passed. All 1,983 unit tests passed with the locked Paperclip CLI `tsx` dependency available for the Mac helper tests. No browser installation was replaced. Other live providers and the native permission prompt were outside this run.
