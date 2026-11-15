#!/bin/bash
set -euo pipefail
TASK_SUPPORT="$HOME/Library/Application Support"
TASK_BRIDGE="$TASK_SUPPORT/Threadkeeper/Bridge"
echo "This removes the Threadkeeper helper. Account profiles, their logins and library backups will be kept."
read -r -p "Type REMOVE to continue: " TASK_ANSWER
if [ "$TASK_ANSWER" != REMOVE ]; then exit 0; fi
for TASK_BROWSER in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Dev" "Google/Chrome Canary" "Google/Chrome for Testing" "Chromium" "Microsoft Edge" "Microsoft Edge Beta" "Microsoft Edge Dev" "Microsoft Edge Canary" "BraveSoftware/Brave-Browser" "Arc/User Data" "Vivaldi" "com.operasoftware.Opera"; do
  rm -f -- "$TASK_SUPPORT/$TASK_BROWSER/NativeMessagingHosts/com.threadkeeper.accounts.json"
done
rm -f -- "$TASK_BRIDGE/launch-host" "$TASK_BRIDGE/config.json" "$TASK_BRIDGE/host.cjs" "$TASK_BRIDGE/core.cjs"
echo "Helper removed. Your dedicated account profiles remain in:"
echo "$TASK_SUPPORT/Threadkeeper/Profiles"
echo "and, if you used Session Control, in:"
echo "$TASK_SUPPORT/SessionControlChrome/Profiles"
echo "Library backups remain in:"
echo "$TASK_SUPPORT/Threadkeeper/Backups"
read -r -p "Press Return to close. " unused
