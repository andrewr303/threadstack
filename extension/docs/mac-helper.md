# Mac helper

## What it is for

The Mac helper is a small program on your Mac that ThreadStack talks to. It does two jobs.

**Account windows.** ThreadStack can keep one account per provider signed in inside the workspace
at a time. If you need two accounts of the same provider signed in at the same moment (two Claude
accounts running Claude Code, two ChatGPT accounts running Codex), give the second one its own
window. The helper opens a Google Chrome window with a separate profile for that account, so its
logins never mix with your main browser.

**Library backups.** A browser keeps ThreadStack's library under the extension's ID. Loading
ThreadStack from another folder, removing and adding it again, or moving to another browser
starts with an empty library. With the helper connected, the whole library is saved to a folder on
your Mac about once an hour when it has changed, and Settings, Accounts, Library backups can
restore it.

It works on macOS with Node.js 22 or newer. ThreadStack itself can run in Chrome, Edge, Brave,
Arc, Vivaldi, Opera or Chromium. Account windows always open in Google Chrome.

## Install

1. In the `mac-helper` folder, double-click `Install Mac Helper.command`.
2. Press Return when asked for an extension ID. The installer finds ThreadStack in every browser
   on this Mac and sets the helper up for each of them.
3. Return to ThreadStack, open Settings, Accounts, and choose Check connection.

If macOS blocks the file, right-click it, choose Open, then confirm. If the installer finds no
ThreadStack, copy the 32-letter ID from the ThreadStack card on the browser's extensions page
(or from Settings, Accounts) and paste it when asked.

Run the installer again after you load ThreadStack in another browser or from another folder.
Each browser has its own list of helpers and each copy of ThreadStack has its own ID; the helper
answers only the IDs it was installed for. IDs registered earlier stay registered.

## If Check connection fails

| Message | Cause | Fix |
| --- | --- | --- |
| Not installed for this browser | The helper is registered with another browser only. Chrome, Edge and the others never look in each other's folders. | Run the installer again. |
| Installed, but not for this copy of ThreadStack | The extension ID changed (another folder or browser), or Node.js was removed. | Run the installer again. |
| The browser did not allow it | The permission prompt was dismissed. | Choose Check connection again and allow it. |

## Uninstall

Double-click `Uninstall Mac Helper.command`, type REMOVE and press Return. This removes the helper
and its registrations. Account profiles, their logins and library backups are kept.

## What it does not do

- It does not read, copy or write cookies, passwords or any login data.
- It does not run shell commands from web pages. It answers three kinds of request: ping, open an
  address in a profile, and store or return a library backup inside its own Backups folder.
- It opens only https addresses on a fixed list of AI sites (Claude, ChatGPT, Grok and X,
  Cursor, Muse and Meta AI, Gemini, AI Studio, Jules, Perplexity, DeepSeek, Mistral, Copilot,
  GitHub, Devin, and the sign-in hosts for OpenAI, xAI and Cursor). Anything else is refused.
- It does not look inside a backup, and it reads or writes no file outside its Backups folder.
- It does not sync profiles or backups between computers.

## Library backups

- Made automatically about once an hour when the library has changed, and on request with Back up
  now. A library with no threads is never backed up.
- The newest five are kept. The largest backup and the ones with the most threads and the most
  messages are never removed, so a new or damaged library cannot push a full one out.
- A backup is also made once a day even if nothing was captured, so changed settings are kept.
- A backup holds threads, messages, summaries, search data, organization, accounts (names only)
  and settings, including any API keys you entered. Saved sign-ins are never in a backup. The
  files are readable only by your macOS user.
- Restoring adds the threads the library lacks, each with everything that belongs to it. A thread
  the library already has, or one deleted there, is left exactly as it is. Settings come back
  only when the library was empty. Accounts need signing in again.
- In an empty library, the panel offers the fullest backup on this Mac straight away.

## The extension ID

A build normally carries a fixed key (`shared/extension-key.json`), so ThreadStack has the same
ID wherever its folder is and the library survives moving the folder or loading another checkout.

A folder that a browser already has loaded under the older, path-based ID keeps that ID, so the
library stays where it is; the build says so. Do not move or rename that folder. A build to another
folder (`TK_OUT_DIR`) has no key unless `TK_STABLE_ID=1` is set.

To move an existing library to the fixed ID, keep the old copy until the new one is checked:

1. In the old ThreadStack: connect the helper and choose Back up now. Check that the newest backup
   in the list shows your thread count.
2. Build a second copy with the fixed ID into its own folder:
   `TK_STABLE_ID=1 TK_OUT_DIR=~/ThreadStack-fixed node scripts/build-extension.mjs`
3. Load that folder on the extensions page (Load unpacked). Both copies are now installed.
4. In the new copy: Settings, Accounts, Check connection, then Restore that backup. Look through
   the library.
5. Only when it is all there, remove the old ThreadStack card. Removing a card deletes that
   copy's library in the browser; the backups on disk stay.

From then on the library follows the fixed ID: a build of any folder with the key opens it.

`node scripts/build-extension.mjs --print-id` shows which ID a build of the folder would have.

## Where files live

| What | Where |
| --- | --- |
| Helper program | `~/Library/Application Support/Threadkeeper/Bridge` |
| Browser registration | `~/Library/Application Support/<browser>/NativeMessagingHosts/com.threadkeeper.accounts.json` |
| Account profiles | `~/Library/Application Support/Threadkeeper/Profiles/<profile id>` |
| Library backups | `~/Library/Application Support/Threadkeeper/Backups` |

These folders and the `com.threadkeeper.accounts` host name keep the extension's original name, so profiles,
backups and browser registrations made before the rename to ThreadStack stay where the helper looks for them.

## Session Control profiles are reused

If you used Session Control, its profiles live in
`~/Library/Application Support/SessionControlChrome/Profiles/<profile id>`. When a profile with
the same id already exists there, the helper uses that folder, so accounts you signed in with
Session Control stay signed in. New profiles are created under `Threadkeeper/Profiles`.
