#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
TASK_NODE="$(command -v node || true)"
if [ -z "$TASK_NODE" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node"; do
    if [ -x "$candidate" ]; then TASK_NODE="$candidate"; break; fi
  done
fi
if [ -z "$TASK_NODE" ]; then
  echo "Install Node.js 22 or newer from https://nodejs.org, then run this installer again."
  read -r -p "Press Return to close. " unused
  exit 1
fi
echo "Threadkeeper · Mac helper setup"
echo "Press Return to find Threadkeeper in your browsers automatically,"
echo "or paste the extension ID from the Threadkeeper card on the extensions page."
read -r -p "Extension ID (optional): " TASK_EXTENSION_ID
echo "To start the Paperclip fork from Threadkeeper, enter its folder."
echo "Leave blank to detect the fork when this installer is inside it."
read -r -p "Paperclip folder (optional): " TASK_PAPERCLIP_ROOT
# Stock macOS Bash treats an empty array as unbound under `set -u`; positional
# arguments preserve literal paths and also support the blank-answer case.
set --
if [ -n "$TASK_PAPERCLIP_ROOT" ]; then set -- --paperclip-root "$TASK_PAPERCLIP_ROOT"; fi
if [ -n "$TASK_EXTENSION_ID" ]; then set -- "$TASK_EXTENSION_ID" "$@"; fi
"$TASK_NODE" install.cjs "$@" || true
read -r -p "Press Return to close. " unused
