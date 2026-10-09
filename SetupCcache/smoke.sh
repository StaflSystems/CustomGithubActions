#!/usr/bin/env bash
# Smoke test for SetupCcache, run by .github/workflows/setup-ccache-smoke.yml.
#
#   smoke.sh miss   first build: every file misses, and nothing errors writing to the store
#   smoke.sh hit    after clearing the local cache: every file hits in the store
#   smoke.sh down   store unreachable: the build still passes, with every file missing
#
# The sources include run_id.h, which holds the run ID, so a run never hits an earlier run's objects.
set -euo pipefail

expect="$1"
cd "$GITHUB_WORKSPACE/smoke"

if [ "$expect" = down ]; then
  sed -i 's/"$/-down"/' run_id.h
  # Nothing listens on port 9.
  export CCACHE_SECONDARY_STORAGE="http://ci:x@127.0.0.1:9|layout=bazel|connect-timeout=200"
fi

ccache -C > /dev/null
ccache -z > /dev/null
for f in f*.c; do
  ccache gcc -c "$f" -o "${f%.c}.o"
done

stat() {
  # --print-stats keys: secondary_* in ccache 4.4–4.6, remote_* from 4.7.
  local v
  v="$(ccache --print-stats | awk -v a="$1" -v b="$2" '$1 == a || $1 == b { s += $2 } END { print s + 0 }')"
  echo "${v:-0}"
}
sources=(f*.c)
files=${#sources[@]}
hits=$(($(stat direct_cache_hit _) + $(stat preprocessed_cache_hit _)))
misses=$(stat cache_miss _)
remote_hits=$(stat secondary_storage_hit remote_storage_hit)
errors=$(($(stat secondary_storage_error remote_storage_error) + $(stat secondary_storage_timeout remote_storage_timeout)))

echo "$(ccache --version | head -1): $files files, $hits hits ($remote_hits from the store), $misses misses, $errors store errors or timeouts"

fail() {
  echo "::error title=SetupCcache smoke test::$expect: $1"
  exit 1
}
case "$expect" in
  miss)
    [ "$misses" -eq "$files" ] || fail "expected $files misses, got $misses"
    [ "$errors" -eq 0 ] || fail "$errors store errors or timeouts"
    ;;
  hit)
    [ "$remote_hits" -eq "$files" ] || fail "expected $files hits from the store, got $remote_hits"
    [ "$errors" -eq 0 ] || fail "$errors store errors or timeouts"
    ;;
  down)
    [ "$misses" -eq "$files" ] || fail "expected $files misses, got $misses"
    ;;
esac
