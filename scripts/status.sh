#!/usr/bin/env bash
# Where is this work? Answers from git, tags and the installed app, never from
# memory: branch state, how far HEAD has travelled
# (on test → beta built → on main → released → installed), and what is on test
# waiting for the next release (the Merge tab list).
#
# Usage: scripts/status.sh [--no-fetch]
#   LAND_TARGET  integration branch (default: test)
set -euo pipefail

TARGET="${LAND_TARGET:-test}"
APP="/Applications/Powerhouse.app/Contents/Info.plist"
cd "$(git rev-parse --show-toplevel)"
[ "${1:-}" = "--no-fetch" ] || git fetch -q --tags origin 2>/dev/null || echo "(fetch failed; showing last known state)"

has() { git rev-parse -q --verify "$1^{commit}" >/dev/null; }
contains() { git merge-base --is-ancestor "$1" "$2" 2>/dev/null; }
yes_no() { if "$@"; then echo yes; else echo no; fi; }
# Oldest tag matching a pattern that contains HEAD, by version order.
first_tag() { git tag --contains HEAD --list "$1" --sort=version:refname | head -n 1; }

BRANCH="$(git symbolic-ref --quiet --short HEAD || echo "(detached)")"
DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"
echo "branch   $BRANCH @ $(git rev-parse --short HEAD)  ($DIRTY uncommitted file(s))"

if has "origin/$TARGET"; then
  read -r BEHIND AHEAD < <(git rev-list --left-right --count "origin/$TARGET...HEAD")
  echo "vs $TARGET  $AHEAD ahead, $BEHIND behind origin/$TARGET"
  if [ "$AHEAD" != 0 ]; then
    echo "unlanded commits (scripts/land.sh lands them):"
    git log --reverse --format='  %h %s' "origin/$TARGET..HEAD"
  fi
fi

echo
echo "delivery of HEAD"
ON_TEST=$(has "origin/$TARGET" && yes_no contains HEAD "origin/$TARGET" || echo no)
BETA="$(first_tag 'beta-v*')"
ON_MAIN=$(has origin/main && yes_no contains HEAD origin/main || echo no)
RELEASE="$(first_tag 'v*')"
INSTALLED_VERSION="$(defaults read "$APP" CFBundleShortVersionString 2>/dev/null || true)"
if [ -z "$INSTALLED_VERSION" ]; then
  INSTALLED="unknown (no $APP)"
elif has "v$INSTALLED_VERSION" && contains HEAD "v$INSTALLED_VERSION"; then
  INSTALLED="yes (v$INSTALLED_VERSION)"
else
  INSTALLED="no (installed v$INSTALLED_VERSION; betas share the version number, so an installed beta can't be told apart)"
fi
echo "  on $TARGET      $ON_TEST"
echo "  beta built   ${BETA:-no}"
echo "  on main      $ON_MAIN"
echo "  released     ${RELEASE:-no}"
echo "  installed    $INSTALLED"

if has "origin/$TARGET" && has origin/main; then
  PENDING="$(git rev-list --count "origin/main..origin/$TARGET")"
  echo
  echo "on $TARGET, not yet released: $PENDING commit(s)"
  git log --format='  %h %s (%an, %ar)' -n 15 "origin/main..origin/$TARGET"
  [ "$PENDING" -gt 15 ] && echo "  … $((PENDING - 15)) more"
fi
exit 0
