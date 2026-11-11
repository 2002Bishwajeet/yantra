#!/usr/bin/env bash
# Exits 0 only when PR $1 may merge: every check done, the five required ones present,
# and none red. With `--merge SUBJECT` it also merges, so a pipe after the call cannot
# turn a red guard into a merge (Y-696: #701 merged red through `| tail`).
set -euo pipefail
pr=$1
subject=
[ "${2:-}" = --merge ] && subject=${3:?merge-guard: --merge needs a subject}
required=(clippy deny fmt test 'cross (aarch64-unknown-linux-musl)')
missing() { for need in "${required[@]}"; do cut -f1 <<<"$rollup" | grep -qxF "$need" || echo "$need"; done; }
for _ in $(seq 1 90); do
  rollup=$(gh pr view "$pr" --json statusCheckRollup -q '.statusCheckRollup[] | "\(.name)\t\(.status)\t\(.conclusion)"')
  # GitHub lists the `test` job only once its shards finish, so a gap with every listed check done is not the end (Y-713).
  grep -qvP '\tCOMPLETED\t' <<<"$rollup" || [ -n "$(missing)" ] || break
  sleep 20
done
fail=0
if grep -vP '\tCOMPLETED\t' <<<"$rollup"; then echo "merge-guard: checks still running" >&2; fail=1; fi
if grep -P '\tCOMPLETED\t' <<<"$rollup" | grep -vP '\t(SUCCESS|SKIPPED|NEUTRAL)$'; then echo "merge-guard: a check is not green" >&2; fail=1; fi
while read -r need; do
  [ -z "$need" ] || { echo "merge-guard: required check '$need' is missing" >&2; fail=1; }
done <<<"$(missing)"
[ "$fail" = 0 ] || exit 1
[ -z "$subject" ] || gh pr merge "$pr" --squash --delete-branch --subject "$subject" --body ""
