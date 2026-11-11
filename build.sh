#!/bin/sh
# Package the extension as dist/tb-trgm-<version>.xpi (version from src/manifest.json).
set -e
cd "$(dirname "$0")"
VERSION=$(node -p 'require("./src/manifest.json").version')
OUT="dist/tb-trgm-$VERSION.xpi"
mkdir -p dist
rm -f "$OUT"
(cd src && zip -qr -X "../$OUT" . -x '*.DS_Store')
echo "$OUT"
