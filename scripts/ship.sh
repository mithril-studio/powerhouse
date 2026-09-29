#!/usr/bin/env bash
# Release what is on test to users: the AGENTS.md ship workflow as one script.
#
#   scripts/ship.sh check [--fast]   is test releasable? commits, version, beta, checks
#   scripts/ship.sh open [--dry-run] open the test → main PR (the human merges it)
#   scripts/ship.sh tag [--dry-run]  after the merge: tag v<version> on main, then watch
#   scripts/ship.sh watch            follow release.yml and verify the published release
#
# check runs scripts/verify.sh in a throwaway worktree of origin/test (skip with
# --fast); CI on the PR only typechecks and runs vitest, and the beta build does
# not run cargo test. The AI review of the diff is the caller's job (ship skill):
# judgment stays with the agent, procedure stays here.
#
# Exit: 0 ok · 1 not ready / failed (reasons printed)
set -euo pipefail

REPO="mithril-studio/powerhouse"
RELEASES_REPO="mithril-studio/powerhouse-releases"
UPDATER_URL="https://github.com/$RELEASES_REPO/releases/latest/download/latest.json"

cd "$(git rev-parse --show-toplevel)"
ROOT="$PWD"
die() { echo "ship: $*" >&2; exit 1; }
version_at() { git show "$1:src-tauri/tauri.conf.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'; }
# All assets of a release, via the per-release assets endpoint: the embedded
# `.assets` field of `gh release view` is eventually consistent (AGENTS.md).
assets() { # repo tag → "state name" lines, empty when the release doesn't exist
  local id
  id="$(gh api "repos/$1/releases/tags/$2" --jq .id 2>/dev/null)" || return 0
  gh api "repos/$1/releases/$id/assets" --jq '.[] | "\(.state) \(.name)"'
}
release_pr() { # open test → main PR as "number url", empty when none
  gh pr list --repo "$REPO" --base main --head test --state open --json number,url -q '.[] | "\(.number) \(.url)"' | head -n 1
}

cmd_check() {
  local fast=0 problems=()
  [ "${1:-}" = "--fast" ] && fast=1
  git fetch -q --tags origin
  local tip version pending
  tip="$(git rev-parse --short origin/test)"
  version="$(version_at origin/test)"
  pending="$(git rev-list --count origin/main..origin/test)"
  echo "release candidate: origin/test @ $tip, version $version"

  echo
  echo "commits in this release ($pending):"
  if [ "$pending" = 0 ]; then
    echo "  (none)"
    problems+=("nothing on test that main doesn't have")
  else
    git log --reverse --format='  %h %s' origin/main..origin/test
  fi

  echo
  echo "version"
  local v
  for f in package.json src-tauri/tauri.conf.json; do
    v="$(git show "origin/test:$f" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
    [ "$v" = "$version" ] || problems+=("$f is at $v, tauri.conf.json at $version")
  done
  v="$(git show origin/test:src-tauri/Cargo.toml | sed -n 's/^version = "\(.*\)"/\1/p' | head -n 1)"
  [ "$v" = "$version" ] || problems+=("Cargo.toml is at $v, tauri.conf.json at $version")
  if git rev-parse -q --verify "refs/tags/v$version" >/dev/null || [ -n "$(assets "$RELEASES_REPO" "v$version")" ]; then
    echo "  v$version is already released"
    problems+=("version not bumped: scripts/bump.sh patch, then scripts/land.sh")
  else
    echo "  v$version is new (last release: $(git tag --list 'v*' --sort=-version:refname | head -n 1))"
  fi

  echo
  echo "beta of the test tip"
  local beta
  beta="$(git tag --points-at origin/test --list 'beta-v*' | head -n 1)"
  if [ -z "$beta" ]; then
    local run
    run="$(gh run list --repo "$REPO" --workflow beta.yml --branch test -L 5 --json headSha,status,conclusion \
      -q ".[] | select(.headSha | startswith(\"$(git rev-parse origin/test)\")) | \"\(.status) \(.conclusion)\"" | head -n 1)"
    echo "  no beta tag on $tip (beta run: ${run:-not found})"
    problems+=("no beta built from the test tip yet; wait for the Beta workflow")
  else
    local dmg
    dmg="$(assets "$REPO" "$beta" | awk '$1 == "uploaded" && $2 ~ /\.dmg$/ {print $2}')"
    if [ -n "$dmg" ]; then
      echo "  $beta: $dmg"
      echo "  install it and check the release's user-visible changes before opening the PR"
    else
      problems+=("beta $beta has no uploaded DMG")
    fi
  fi

  echo
  echo "checks"
  if [ "$fast" = 1 ]; then
    echo "  skipped (--fast)"
  else
    local wt log
    wt="$(mktemp -d)"
    log="$(mktemp)"
    git worktree add -q --detach "$wt" origin/test
    # Reuse this checkout's cargo build cache; a cold one costs minutes.
    if (cd "$wt" && pnpm install --frozen-lockfile && CARGO_TARGET_DIR="$ROOT/src-tauri/target" ./scripts/verify.sh) >"$log" 2>&1; then
      echo "  verify.sh passed on origin/test @ $tip"
    else
      tail -30 "$log" | sed 's/^/  /'
      problems+=("verify.sh failed on origin/test (full log: $log)")
    fi
    git worktree remove --force "$wt"
  fi

  echo
  local pr
  pr="$(release_pr)"
  [ -n "$pr" ] && echo "open release PR: ${pr#* }"
  if [ ${#problems[@]} = 0 ]; then
    echo "READY to ship v$version"
    echo "diff for review: git diff --stat origin/main...origin/test"
  else
    echo "NOT READY:"
    printf '  - %s\n' "${problems[@]}"
    return 1
  fi
}

cmd_open() {
  local dry=0
  [ "${1:-}" = "--dry-run" ] && dry=1
  git fetch -q --tags origin
  local pr version beta body
  pr="$(release_pr)"
  [ -n "$pr" ] && { echo "release PR already open: ${pr#* }"; return 0; }
  version="$(version_at origin/test)"
  git rev-parse -q --verify "refs/tags/v$version" >/dev/null && die "v$version is already released; bump first"
  [ "$(git rev-list --count origin/main..origin/test)" != 0 ] || die "nothing on test to release"
  beta="$(git tag --points-at origin/test --list 'beta-v*' | head -n 1)"
  body="$(
    echo "## Release v$version"
    echo
    echo "Everything on \`test\` that is not on \`main\`, oldest first:"
    echo
    git log --reverse --format='- %h %s' origin/main..origin/test
    echo
    echo "## Verification"
    echo
    echo "- Beta: ${beta:-none on the test tip}"
    echo "- After merging, run \`scripts/ship.sh tag\` to tag v$version and publish."
  )"
  if [ "$dry" = 1 ]; then
    echo "would run: gh pr create --repo $REPO --base main --head test --title \"Release v$version\""
    echo "$body"
    return 0
  fi
  gh pr create --repo "$REPO" --base main --head test --title "Release v$version" --body "$body"
}

cmd_tag() {
  local dry=0
  [ "${1:-}" = "--dry-run" ] && dry=1
  git fetch -q --tags origin
  local version tag
  version="$(version_at origin/main)"
  tag="v$version"
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "$tag already exists; nothing to tag (bump for a new release)"
  [ -n "$(release_pr)" ] && die "the release PR is still open; merge it first"
  echo "tagging $tag at origin/main @ $(git rev-parse --short origin/main): $(git log -1 --format=%s origin/main)"
  if [ "$dry" = 1 ]; then
    echo "would run: git tag -a $tag origin/main && git push origin refs/tags/$tag"
    return 0
  fi
  git tag -a "$tag" -m "Powerhouse $tag" origin/main
  git push -q origin "refs/tags/$tag"
  echo "pushed $tag; release.yml builds, signs, notarizes and publishes it"
  cmd_watch "$tag"
}

cmd_watch() {
  local tag="${1:-}" run="" i
  [ -n "$tag" ] || tag="$(git tag --list 'v*' --sort=-version:refname | head -n 1)"
  echo "waiting for the Release run of $tag"
  for i in $(seq 1 24); do
    run="$(gh run list --repo "$REPO" --workflow release.yml -L 10 --json databaseId,headBranch \
      -q ".[] | select(.headBranch == \"$tag\") | .databaseId" | head -n 1)"
    [ -n "$run" ] && break
    sleep 5
  done
  [ -n "$run" ] || die "no Release run for $tag after 2 minutes; check GitHub Actions"
  gh run watch "$run" --repo "$REPO" --exit-status --interval 30 >/dev/null \
    || die "Release run failed: gh run view $run --repo $REPO --log-failed"
  echo "Release run passed"

  local version="${tag#v}" listed missing=()
  listed="$(assets "$RELEASES_REPO" "$tag")"
  for want in latest.json "_aarch64.app.tar.gz" "_aarch64.app.tar.gz.sig" ".dmg"; do
    grep -q "^uploaded .*${want//./\\.}$" <<<"$listed" || missing+=("$want")
  done
  [ ${#missing[@]} = 0 ] || die "release $tag is missing uploaded assets: ${missing[*]}"
  echo "assets uploaded to $RELEASES_REPO $tag"
  local served=""
  for i in $(seq 1 12); do
    served="$(curl -fsSL "$UPDATER_URL" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{}})')"
    [ "$served" = "$version" ] && break
    sleep 10
  done
  [ "$served" = "$version" ] || die "updater still serves ${served:-nothing} instead of $version"
  echo "updater serves $version; installed apps pick it up on their next update check"
}

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  open) shift; cmd_open "$@" ;;
  tag) shift; cmd_tag "$@" ;;
  watch) shift; cmd_watch "$@" ;;
  *) die "usage: scripts/ship.sh check [--fast] | open [--dry-run] | tag [--dry-run] | watch [tag]" ;;
esac
