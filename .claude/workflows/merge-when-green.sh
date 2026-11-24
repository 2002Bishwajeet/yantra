#!/usr/bin/env bash
# Merges PR $1 with subject $2 once CI is green, one merge at a time across watchers.
# Since Y-836 the ruleset lets a branch behind main merge; BEHIND stays handled in case that returns.
# Exits 0 on merge, 1 on a red check or a conflict, so the watcher's exit wakes the session.
set -uo pipefail
pr=$1 subject=$2
here=$(dirname "$0")
lock=${XDG_RUNTIME_DIR:-/tmp}/yantra-merge.lock
for _ in 1 2 3 4 5 6; do
  timeout 2400 bash "$here/merge-guard.sh" "$pr" || { echo "merge-when-green: #$pr is not green"; exit 1; }
  exec 9>"$lock"; flock 9
  state=$(gh pr view "$pr" --json mergeStateStatus -q .mergeStateStatus)
  case $state in
    CLEAN|HAS_HOOKS|UNSTABLE)
      if bash "$here/merge-guard.sh" "$pr" --merge "$subject"; then echo "merge-when-green: #$pr merged"; exit 0; fi ;;
    BEHIND) gh pr update-branch "$pr" ;;
    DIRTY) echo "merge-when-green: #$pr conflicts with main"; exit 1 ;;
  esac
  flock -u 9
  sleep 60
done
echo "merge-when-green: #$pr gave up after six tries"; exit 1
