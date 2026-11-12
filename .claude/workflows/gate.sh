#!/usr/bin/env bash
# Y-703: a row's local checks run on an idle tailnet machine, so parallel rows do not run the laptop out of memory.
#   gate.sh run <worktree> <command>   prints "gate-machine: <host>", then runs the command there; exits with its code
# A gate host checks the pushed commit out of GitHub into ~/yantra-gate/yantra, one gate at a time, so its target
# directory stays warm. The command runs under nice and a memory cap. The laptop is the fallback, also one at a time.
set -euo pipefail
cmd=$1 wt=$(realpath "$2")
shift 2
hosts=${GATE_HOSTS:-yantra-box}
mem=${GATE_MEMORY_MAX:-8G}
min_free_gb=${GATE_MIN_FREE_GB:-6}
ssh_=(ssh -o BatchMode=yes -o ConnectTimeout=10)

# The tools a command needs. yantra-box has Node 20 and no cargo-deny (2026-11-10), so it takes Rust checks only.
# It has no ~/.ssh/id_yantra either, so `just test-mac` runs on the laptop (Y-679).
tools() {
  local t='git flock systemd-run nice'
  grep -qE 'cargo|just' <<<"$1" && t+=' cargo cargo-nextest just'
  grep -qE 'npm|npx|node|web' <<<"$1" && t+=' node22'
  grep -qE 'deny' <<<"$1" && t+=' cargo-deny'
  grep -qE 'podman' <<<"$1" && t+=' podman'
  grep -qE 'test-mac' <<<"$1" && t+=' id_yantra'
  echo "$t"
}

# Prints why the host is not eligible, and exits 1; exits 0 when it is idle and has every tool.
# shellcheck disable=SC2016
probe='read -r l1 _ </proc/loadavg
n=$(nproc)
free=$(awk "/MemAvailable/ {print int(\$2 / 1048576)}" /proc/meminfo)
awk -v l="$l1" -v n="$n" "BEGIN { exit !(l < n / 2) }" || { echo "load $l1 on $n cores"; exit 1; }
[ "$free" -ge "$min_free_gb" ] || { echo "only $free GB free"; exit 1; }
for t in $tools; do
  case $t in
  node22) node -e "const [a, b] = process.versions.node.split(\".\").map(Number); process.exit(Number(a === 22 ? b < 18 : a < 24 || (a === 24 && b < 11)))" 2>/dev/null || { echo "no Node 22.18 or 24.11"; exit 1; } ;;
  id_yantra) [ -r ~/.ssh/id_yantra ] || { echo "no ~/.ssh/id_yantra to reach the Mac"; exit 1; } ;;
  *) command -v "$t" >/dev/null || { echo "no $t"; exit 1; } ;;
  esac
done'

# fd 9 holds the lock for the whole run; exit 75 means another gate holds it.
# shellcheck disable=SC2016
remote='set -euo pipefail
mkdir -p ~/yantra-gate
exec 9>~/yantra-gate/.lock
flock -n 9 || exit 75
dir=~/yantra-gate/yantra
[ -d "$dir/.git" ] || git clone -q --filter=blob:none "$url" "$dir"
git -C "$dir" fetch -q origin "$branch"
git -C "$dir" checkout -qf --detach "$sha"
git -C "$dir" clean -fdq
cd "$dir"
# .cargo/config.toml links with mold, and yantra-box has none. RUSTFLAGS replaces that list, and the toolchain links with its own lld.
command -v mold >/dev/null || export RUSTFLAGS=-Clink-arg=-fuse-ld=lld
exec systemd-run --user --scope -q -p MemoryMax="$mem" nice -n 10 bash -c "$command"'

case $cmd in
run)
  command=$1
  tools=$(tools "$command")
  branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
  sha=$(git -C "$wt" rev-parse HEAD)
  url=$(git -C "$wt" remote get-url origin)
  pushed=$(git -C "$wt" ls-remote origin "refs/heads/$branch" | cut -f1)
  if [ "$pushed" = "$sha" ]; then
    for host in $hosts; do
      if ! why=$("${ssh_[@]}" "$host" bash -s < <(declare -p tools min_free_gb; echo "$probe") 2>&1); then
        echo "gate: $host is not eligible: ${why:-unreachable}" >&2
        continue
      fi
      echo "gate-machine: $host"
      set +e
      "${ssh_[@]}" "$host" bash -s < <(declare -p url branch sha mem command; echo "$remote")
      code=$?
      set -e
      [ $code -eq 75 ] && { echo "gate: $host is running another gate" >&2; continue; }
      exit $code
    done
  elif [[ $branch == y-*-auto ]] && git -C "$wt" push -q origin "HEAD:refs/heads/$branch" 2>/dev/null; then
    # Y-804: an unpushed fix commit sent every gate to the laptop. A harness branch is pushed so a gate host can take it.
    exec "$0" run "$wt" "$command"
  else
    echo "gate: HEAD $sha is not pushed to origin/$branch, so it runs on this machine" >&2
  fi
  echo "gate-machine: $(hostname) (local)"
  exec 9>"${XDG_RUNTIME_DIR:-/tmp}/yantra-gate.lock"
  flock 9
  cd "$wt"
  # Y-799: other projects' agents on this laptop take the same machine-wide lock for their heavy commands.
  # Y-804: the laptop shares 16 GB with other sessions, and oomd killed them at the 8 GB gate-host cap.
  # Y-807: heavy opens its own capped scope, so it gets the cap instead of a second systemd-run.
  [ -x ~/.claude/bin/heavy ] && exec env HEAVY_MEM="${GATE_LOCAL_MEMORY_MAX:-4G}" ~/.claude/bin/heavy nice -n 10 bash -c "$command"
  exec systemd-run --user --scope -q -p MemoryMax="${GATE_LOCAL_MEMORY_MAX:-4G}" -p MemorySwapMax=1G nice -n 10 bash -c "$command"
  ;;

*)
  echo "gate: unknown command $cmd" >&2
  exit 1
  ;;
esac
