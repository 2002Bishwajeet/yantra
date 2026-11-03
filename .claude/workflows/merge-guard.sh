#!/usr/bin/env bash
# Exits 0 only when PR $1 may merge: every check done, the five required ones present,
# and none red. The ship agent runs it as `merge-guard.sh N && gh pr merge`, so a
# prose check cannot be skipped (Y-609: #568 merged with `web` red).
set -euo pipefail
pr=$1
for _ in $(seq 1 90); do
  rollup=$(gh pr view "$pr" --json statusCheckRollup -q '.statusCheckRollup[] | "\(.name)\t\(.status)\t\(.conclusion)"')
  grep -qvP '\tCOMPLETED\t' <<<"$rollup" || break
  sleep 20
done
fail=0
if grep -vP '\tCOMPLETED\t' <<<"$rollup"; then echo "merge-guard: checks still running" >&2; fail=1; fi
if grep -P '\tCOMPLETED\t' <<<"$rollup" | grep -vP '\t(SUCCESS|SKIPPED|NEUTRAL)$'; then echo "merge-guard: a check is not green" >&2; fail=1; fi
for need in clippy deny fmt test 'cross (aarch64-unknown-linux-musl)'; do
  cut -f1 <<<"$rollup" | grep -qxF "$need" || { echo "merge-guard: required check '$need' is missing" >&2; fail=1; }
done
exit $fail
