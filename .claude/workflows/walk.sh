#!/usr/bin/env bash
# Y-660: a row that changes a screen or a machine path is proved on the real product, not only on the fixture.
#   walk.sh needs <worktree>            prints "web" and/or "machine" for what the branch's diff touches
#   walk.sh up <worktree>               builds the branch's yantrad and dashboard and serves them against the real fleet
#   walk.sh shoot <worktree> <route>... screenshots and the visible text of each route, WebKit at 390 px, Chromium at 1440 px
#   walk.sh down <worktree>
#   walk.sh mac <worktree>              runs `just test-mac` against the real Mac; exit 2 when the Mac is unreachable
#   walk.sh publish <worktree> <pr>     pushes the screenshots to the `walks` branch and comments them on the PR
#   walk.sh guard <pr>                  exits non-zero when the PR needs a walk and has no walk comment
set -euo pipefail
here=$(dirname "$(realpath "$0")")
cmd=$1
shift
port=${WALK_PORT:-17717}
mac=${WALK_MAC:-biswa@bishwajeets-macbook-pro}
marker='<!-- yantra-walk -->'

kinds() {
  grep -qE '^web/(src/|index\.html$)' <<<"$1" && echo web
  grep -qE '^crates/yantra-core/src/(keep|claude|chat|tmux|remote|probe)|^crates/yantrad/src/chat\.rs$' <<<"$1" && echo machine
  true
}

case $cmd in
needs)
  kinds "$(git -C "$1" diff --name-only origin/main...HEAD)"
  ;;

up)
  wt=$(realpath "$1") dir="$(realpath "$1")/.walk"
  mkdir -p "$dir"
  [ -f "$dir/daemon.pid" ] && "$0" down "$wt"
  # Y-697: a daemon left by another row answers the health check below, and the walk then shoots that row's build.
  if [ -n "$(ss -ltnH "sport = :$port")" ]; then
    echo "walk: port $port is already in use; stop that daemon with 'walk.sh down <its worktree>' or set WALK_PORT" >&2
    ss -ltnpH "sport = :$port" >&2
    exit 1
  fi
  (cd "$wt" && CARGO_TARGET_DIR="$wt/target" cargo build --bin yantrad)
  (cd "$wt/web" && { [ -d node_modules ] || npm ci --prefer-offline; } && npx vite build)
  # The developer's own yantrad holds 7717 on the tailnet addresses, so this one runs in its own network
  # namespace, as `just appliance-runtime` does, with pasta for the outbound ssh and the inbound port.
  rm -rf "$dir/etc-ssh" && mkdir -p "$dir/etc-ssh"
  # ssh refuses a config owned by an unmapped root, and the namespace maps only this user.
  cp -rL /etc/ssh/ssh_config /etc/ssh/ssh_config.d "$dir/etc-ssh/"
  v4=$(tailscale ip -4)
  # shellcheck disable=SC2016
  setsid pasta --config-net -T none -U none -t "127.0.0.1/$port:7718" -- unshare --mount bash -c '
    set -eu
    for a in $(tailscale ip); do
      case $a in *:*) ip -6 addr add "$a/128" dev lo ;; *) ip addr add "$a/32" dev lo ;; esac
    done
    mount --bind "$1/etc-ssh" /etc/ssh
    exec unshare --user --map-user="$2" --map-group="$3" bash -c "
      socat TCP-LISTEN:7718,fork,reuseaddr TCP:$4:7717 &
      YANTRA_WEB=$5/web/dist exec $5/target/debug/yantrad"' _ "$dir" "$(id -u)" "$(id -g)" "$v4" "$wt" \
    >"$dir/daemon.log" 2>&1 </dev/null &
  echo $! >"$dir/daemon.pid"
  for _ in $(seq 60); do
    curl -sf "http://127.0.0.1:$port/healthz" >/dev/null && { echo "http://127.0.0.1:$port"; exit 0; }
    sleep 1
  done
  echo "walk: yantrad did not answer on $port; see $dir/daemon.log" >&2
  tail -20 "$dir/daemon.log" >&2
  "$0" down "$wt"
  exit 1
  ;;

shoot)
  wt=$(realpath "$1") dir="$(realpath "$1")/.walk"
  shift
  [ $# -gt 0 ] || { echo "walk: name at least one route" >&2; exit 1; }
  rm -rf "$dir/shots" && mkdir -p "$dir/shots"
  image=$(grep -m1 -oE 'mcr.microsoft.com/playwright:v[0-9.]+-noble' "$wt/.github/workflows/web.yml")
  nm=$(readlink -f "$wt/web/node_modules")
  podman run --rm --network=host -v "$wt:/work" -v "$nm:$nm" -v "$here/walk.mjs:/walk.mjs:ro" \
    -w /work/web "$image" node /walk.mjs "http://127.0.0.1:$port" /work/.walk/shots "$@"
  ls "$dir"/shots/*.png "$dir"/shots/*.txt
  ;;

down)
  dir="$(realpath "$1")/.walk"
  [ -f "$dir/daemon.pid" ] || exit 0
  kill -TERM -- "-$(cat "$dir/daemon.pid")" 2>/dev/null || true
  rm -f "$dir/daemon.pid"
  ;;

mac)
  wt=$(realpath "$1") dir="$(realpath "$1")/.walk"
  mkdir -p "$dir"
  host=${mac#*@}
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$mac" true || { echo "walk: $mac is unreachable" >&2; exit 2; }
  # These two end every tmux session on the Mac, and the owner may be working there.
  set +e
  (cd "$wt" && just test-mac "$mac" \
    --skip a_session_starts_on_the_mac_after_tmux_kill_server \
    --skip the_agents_hooks_find_their_commands_on_the_mac) >"$dir/test-mac.log" 2>&1
  code=$?
  set -e
  { [ $code -eq 0 ] && echo "pass" || echo "fail"; grep -E '^test result|^test .* (ok|FAILED|ignored)' "$dir/test-mac.log"; } >"$dir/test-mac.txt"
  sed -i "1s/^/$host: /" "$dir/test-mac.txt"
  cat "$dir/test-mac.txt"
  exit $code
  ;;

publish)
  wt=$(realpath "$1") dir="$(realpath "$1")/.walk" pr=$2
  repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  head=$(git -C "$wt" rev-parse HEAD)
  branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
  shots=("$dir"/shots/*.png)
  [ -e "${shots[0]}" ] || { echo "walk: no screenshots in $dir/shots" >&2; exit 1; }
  # A branch of its own, so the images never enter main's history.
  parent=$(git -C "$wt" ls-remote origin refs/heads/walks | cut -f1)
  [ -z "$parent" ] || git -C "$wt" fetch -q origin walks
  index=$(mktemp)
  trap 'rm -f "$index"' EXIT
  export GIT_INDEX_FILE=$index
  if [ -n "$parent" ]; then git -C "$wt" read-tree "$parent"; else git -C "$wt" read-tree --empty; fi
  for f in "${shots[@]}"; do
    git -C "$wt" update-index --add --cacheinfo "100644,$(git -C "$wt" hash-object -w "$f"),$branch/${head:0:12}/$(basename "$f")"
  done
  commit=$(git -C "$wt" commit-tree "$(git -C "$wt" write-tree)" ${parent:+-p "$parent"} -m "Walk for #$pr at ${head:0:12}")
  unset GIT_INDEX_FILE
  git -C "$wt" push -q origin "$commit:refs/heads/walks"
  raw="https://raw.githubusercontent.com/$repo/$commit/$branch/${head:0:12}"
  {
    echo "$marker"
    echo "## Walk at ${head:0:12}"
    echo
    echo "The branch's \`yantrad\` and dashboard against the real fleet: WebKit at 390 px, Chromium at 1440 px."
    if [ -f "$dir/test-mac.txt" ]; then
      echo
      echo "\`just test-mac\`: $(head -1 "$dir/test-mac.txt")"
      head -1 "$dir/test-mac.txt" | grep -q ': pass$' && echo '<!-- yantra-test-mac: pass -->'
    fi
    echo
    echo "| Screen | Phone, WebKit | Desktop, Chromium |"
    echo "| --- | --- | --- |"
    for f in "$dir"/shots/*-desktop-chromium.png; do
      screen=$(basename "$f" -desktop-chromium.png)
      phone=
      for p in "$dir/shots/$screen"-phone-webkit-*.png; do phone+="<img src=\"$raw/$(basename "$p")\" width=\"160\"> "; done
      echo "| \`$screen\` | $phone| <img src=\"$raw/$screen-desktop-chromium.png\" width=\"480\"> |"
    done
  } >"$dir/comment.md"
  gh pr comment "$pr" --body-file "$dir/comment.md"
  ;;

guard)
  pr=$1
  need=$(kinds "$(gh pr diff "$pr" --name-only)")
  [ -n "$need" ] || exit 0
  bodies=$(gh pr view "$pr" --json comments -q '.comments[].body')
  grep -qF "$marker" <<<"$bodies" || { echo "walk-guard: PR $pr changes a ${need//$'\n'/ and } path and has no walk screenshots" >&2; exit 1; }
  if grep -qx machine <<<"$need"; then
    grep -qF '<!-- yantra-test-mac: pass -->' <<<"$bodies" || { echo "walk-guard: PR $pr changes a machine path and has no passing test-mac run" >&2; exit 1; }
  fi
  ;;

*)
  echo "walk: unknown command $cmd" >&2
  exit 1
  ;;
esac
