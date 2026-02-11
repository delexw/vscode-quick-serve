#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

EXT_ID="quick-serve.vscode-quick-serve"

# Detect editor CLI
if command -v cursor &>/dev/null; then
  CLI=cursor
elif command -v code &>/dev/null; then
  CLI=code
else
  echo "Error: neither 'code' nor 'cursor' found in PATH" >&2
  exit 1
fi

echo "Using: $CLI"

# Clean old .vsix files
rm -f ./*.vsix

# Package
npx @vscode/vsce package

# Find the built .vsix
VSIX=$(ls -1t ./*.vsix 2>/dev/null | head -1)
if [ -z "$VSIX" ]; then
  echo "Error: no .vsix file found after packaging" >&2
  exit 1
fi

echo "Installing: $VSIX"

$CLI --disable-extension "$EXT_ID" 2>/dev/null || true
$CLI --install-extension "$VSIX"
$CLI --enable-extension "$EXT_ID" 2>/dev/null || true

echo "Done. Reload the window to activate."
