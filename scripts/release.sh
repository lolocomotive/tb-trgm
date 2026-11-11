#!/bin/sh
# Cut a release: bump the version everywhere, test, commit and tag.
#   npm run release -- 1.2.0
# Then push:  git push && git push origin v1.2.0
# The GitHub workflow builds the .xpi and publishes the release for the tag.
set -e
cd "$(dirname "$0")/.."
VERSION="$1"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: npm run release -- <major.minor.patch>" >&2; exit 1 ;;
esac
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree not clean; commit or stash first" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  echo "tag v$VERSION already exists" >&2
  exit 1
fi
node -e '
  const fs = require("fs");
  for (const f of ["src/manifest.json", "package.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = process.argv[1];
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }
' "$VERSION"
npm test
sh build.sh
git add src/manifest.json package.json
git commit -m "Release v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
echo "Tagged v$VERSION. Push with: git push && git push origin v$VERSION"
