#!/usr/bin/env bash
# Bump the app version everywhere it lives (package.json, tauri.conf.json,
# Cargo.toml, Cargo.lock) and commit `chore(release): X.Y.Z`. Does not push:
# land the commit with scripts/land.sh like any other.
#
# Usage: scripts/bump.sh patch|minor|major|X.Y.Z
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
die() { echo "bump: $*" >&2; exit 1; }

[ $# = 1 ] || die "usage: scripts/bump.sh patch|minor|major|X.Y.Z"
git diff --quiet && git diff --cached --quiet || die "uncommitted changes; commit them first"

CURRENT="$(node -p "require('./src-tauri/tauri.conf.json').version")"
for f in package.json; do
  v="$(node -p "require('./$f').version")"
  [ "$v" = "$CURRENT" ] || die "$f is at $v but tauri.conf.json is at $CURRENT; fix by hand first"
done
IFS=. read -r MA MI PA <<<"$CURRENT"
case "$1" in
  patch) NEXT="$MA.$MI.$((PA + 1))" ;;
  minor) NEXT="$MA.$((MI + 1)).0" ;;
  major) NEXT="$((MA + 1)).0.0" ;;
  [0-9]*.[0-9]*.[0-9]*) NEXT="$1" ;;
  *) die "unknown bump '$1'; use patch, minor, major or X.Y.Z" ;;
esac
[ "$NEXT" != "$CURRENT" ] || die "already at $CURRENT"
git rev-parse -q --verify "refs/tags/v$NEXT" >/dev/null && die "tag v$NEXT already exists; pick a higher version"

# Replace exactly the version field in each file, and fail if it wasn't there.
set_version() { # file perl-regex-with-VERSION-capture
  perl -0pi -e "s/$2/\${1}$NEXT\${2}/ or die \"no version field in $1\n\"" "$1"
}
set_version package.json '("version":\s*")[^"]+(")'
set_version src-tauri/tauri.conf.json '("version":\s*")[^"]+(")'
set_version src-tauri/Cargo.toml '(\[package\][^\[]*?\nversion = ")[^"]+(")'
set_version src-tauri/Cargo.lock '(\nname = "powerhouse"\nversion = ")[^"]+(")'

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -q -m "chore(release): $NEXT"
echo "bumped $CURRENT → $NEXT ($(git rev-parse --short HEAD)); land it with scripts/land.sh"
