# Mac helper

## What it is for

Threadkeeper can keep one account per provider signed in inside the workspace at a time. If you
need two accounts of the same provider signed in at the same moment, give the second one its own
Chrome window. The Mac helper is a small program that opens a Chrome window with a separate
profile for that account, so its logins never mix with your main browser.

It works on macOS with Google Chrome and Node.js 22 or newer.

## Install

1. Open `chrome://extensions` and copy the 32-letter ID on the Threadkeeper card.
2. In the `mac-helper` folder, double-click `Install Mac Helper.command`.
3. Paste the extension ID when asked and press Return.
4. Return to Threadkeeper and check the helper connection.

If macOS blocks the file, right-click it, choose Open, then confirm.

The installer binds the helper to that one extension ID. Another extension cannot call it.

## Uninstall

Double-click `Uninstall Mac Helper.command`, type REMOVE and press Return. This removes the
launcher and its registration. Account profiles and their logins are kept.

## What it does not do

- It does not read, copy or write cookies, passwords or any login data.
- It does not run shell commands from web pages. It receives two requests only: ping, and open
  an address in a profile.
- It opens only https addresses on a fixed list of AI sites (Claude, ChatGPT, Grok and X,
  Cursor, Muse and Meta AI, Gemini, AI Studio, Jules, Perplexity, DeepSeek, Mistral, Copilot,
  GitHub, Devin, and the sign-in hosts for OpenAI, xAI and Cursor). Anything else is refused.
- It does not sync profiles between computers.

## Where files live

| What | Where |
| --- | --- |
| Helper program | `~/Library/Application Support/Threadkeeper/Bridge` |
| Chrome registration | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.threadkeeper.accounts.json` |
| Account profiles | `~/Library/Application Support/Threadkeeper/Profiles/<profile id>` |

## Session Control profiles are reused

If you used Session Control, its profiles live in
`~/Library/Application Support/SessionControlChrome/Profiles/<profile id>`. When a profile with
the same id already exists there, the helper uses that folder, so accounts you signed in with
Session Control stay signed in. New profiles are created under Threadkeeper.
