#!/bin/sh
# Unpack the Chrome extension zip to a fixed folder for Load unpacked.
set -e
DEST="${HOME}/Documents/split-finder"
ZIP="${1:?Pass path to bundle-split-finder-*-chrome.zip}"
mkdir -p "$DEST"
rm -rf "${DEST:?}"/*
unzip -q -o "$ZIP" -d "$DEST"
# Flatten one level if WXT nested chrome-mv3/
inner=$(find "$DEST" -mindepth 1 -maxdepth 2 -name manifest.json -print | head -1)
if [ -n "$inner" ]; then
  dir=$(dirname "$inner")
  if [ "$dir" != "$DEST" ]; then
    mv "$dir"/* "$DEST"/
    rmdir "$dir" 2>/dev/null || true
  fi
fi
echo "Load unpacked from: $DEST"
open -a "Google Chrome" "chrome://extensions/" 2>/dev/null || true