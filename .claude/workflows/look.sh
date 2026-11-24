#!/usr/bin/env bash
# Y-835: the build loop reads the real box before it builds (CLAUDE.md §B7), with the owner's read-only session
# (ADR-0044's note of 2026-11-24). It opens pages and presses nothing.
#   look.sh <out dir> [route...]   a PNG and a TXT of each route, WebKit at 390 px and Chromium at 1440 px.
#                                  With no route it shoots the pages the owner uses; look.mjs holds the list.
# LOOK_ORIGIN is the box's dashboard. LOOK_SESSION is the file that holds the token, mode 600.
# Exit 3: the laptop holds no usable session, so the owner makes one. Exit 4: the box does not answer.
# It takes the laptop's lock for heavy commands by itself. The lock does not nest, so never run look.sh under heavy.
# The token is read from the file alone. It never goes in argv, an environment, a log or a file under <out dir>.
set -euo pipefail
here=$(dirname "$(realpath "$0")")
out=${1:?look: name the directory for the pictures}
shift
origin=${LOOK_ORIGIN:-https://yantra.cloudx.run}
session=${LOOK_SESSION:-$HOME/.config/yantra/walk-session}
cookie=__Host-yantra_session
make="make one on the box's dashboard, in Settings, Devices, Read-only session, and save the token in $session with mode 600"

[ -f "$session" ] || { echo "look: $session is not there; $make" >&2; exit 3; }
[ -s "$session" ] || { echo "look: $session is empty; $make" >&2; exit 3; }
mode=$(stat -Lc %a "$session")
[ "$mode" = 600 ] || { echo "look: $session has mode $mode; run chmod 600 on it" >&2; exit 3; }
IFS= read -r token <"$session" || true
token=${token//[[:space:]]/}
# The token goes into a curl config below, so anything but a token's own characters is refused first.
[[ $token =~ ^[A-Za-z0-9_-]{32,128}$ ]] || { echo "look: $session does not hold a session token; $make" >&2; exit 3; }

curl -sf --max-time 15 -o /dev/null "$origin/healthz" || { echo "look: $origin does not answer /healthz" >&2; exit 4; }
# The cookie is Secure, and the token must not cross a network in the clear or reach a path or a second host.
[[ $origin =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "look: LOOK_ORIGIN must be one https origin, not $origin" >&2; exit 2; }

# The config reaches curl on a file descriptor, and printf is a shell builtin, so no process has the token in its argv.
answer=$(curl -s --max-time 15 --proto '=https' -o /dev/null -w '%{http_code}' -K /dev/fd/3 "$origin/api/workspaces" \
  3< <(printf 'header = "Cookie: %s=%s"\n' "$cookie" "$token")) || answer=none
unset token
case $answer in
200) ;;
401) echo "look: the session in $session has ended or was revoked; $make" >&2; exit 3 ;;
*) echo "look: $origin answered $answer to a read with the session, so the box cannot be read from here" >&2; exit 4 ;;
esac

curl -sf --max-time 15 "$origin/api/about" | python3 -c '
import json, sys
about = json.load(sys.stdin)
published = about.get("published") or {}
newer = (published.get("data") or {}).get("newer") if published.get("looked") == "ok" else "unknown"
print("box: version %s, channel %s, newer %s" % (about.get("version"), about.get("channel"), newer))'

repo=$(git -C "$here" rev-parse --show-toplevel)
image=$(grep -m1 -oE 'mcr.microsoft.com/playwright:v[0-9.]+-noble' "$repo/.github/workflows/web.yml")
# The lock is taken here, after the session is known to work, so a run with no session never waits for it.
heavy=()
[ -x ~/.claude/bin/heavy ] && heavy=(~/.claude/bin/heavy)
# The checkout that the build loop runs from builds nothing, so its node_modules can hold only Vite's cache.
if [ ! -d "$repo/web/node_modules/@playwright/test" ] || [ "$repo/web/package-lock.json" -nt "$repo/web/node_modules/.package-lock.json" ]; then
  (cd "$repo/web" && "${heavy[@]}" npm ci --prefer-offline) ||
    { echo "look: npm ci failed in $repo/web, so the look has no browser to run" >&2; exit 1; }
fi
nm=$(readlink -f "$repo/web/node_modules")
mkdir -p "$out"
out=$(realpath "$out")
rm -f "$out"/*.png "$out"/*.txt
"${heavy[@]}" podman run --rm --network=host --memory "${LOOK_MEMORY:-4g}" --memory-swap "${LOOK_MEMORY:-4g}" \
  -v "$repo/web:/work/web:ro" -v "$nm:$nm:ro" -v "$here/look.mjs:/look.mjs:ro" \
  -v "$(realpath "$session"):/look-session:ro" -v "$out:/out" \
  -w /work/web "$image" node /look.mjs "$origin" /out /look-session "$@"
ls "$out"/*.png "$out"/*.txt
