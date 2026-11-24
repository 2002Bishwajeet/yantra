#!/usr/bin/env bash
# Y-835: look.sh must reach its browser from the checkout the build loop runs it in, where web/node_modules
# holds only Vite's cache. curl, npm, podman and the lock are stand-ins here, so this proves the steps look.sh
# takes and their order. It does not prove the look against a box. Run it with `just look-test`.
set -euo pipefail
here=$(dirname "$(realpath "$0")")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde
failed=0

mkdir -p "$tmp/bin" "$tmp/home/.claude/bin"
cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >>"$CALLS"
case "$*" in
*http_code*) printf 200 ;;
*/api/about) echo '{"version":"0.0.0","channel":"nightly","published":{"looked":"ok","data":{"newer":false}}}' ;;
esac
EOF
cat >"$tmp/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $* in $PWD" >>"$CALLS"
[ -z "${NPM_FAILS:-}" ] || exit 1
mkdir -p node_modules/@playwright/test && touch node_modules/.package-lock.json
EOF
cat >"$tmp/bin/podman" <<'EOF'
#!/usr/bin/env bash
echo "podman $*" >>"$CALLS"
touch "$SHOTS/home-desktop-chromium.png" "$SHOTS/home-desktop-chromium.txt"
EOF
cat >"$tmp/home/.claude/bin/heavy" <<'EOF'
#!/usr/bin/env bash
echo "heavy $1" >>"$CALLS"
exec "$@"
EOF
chmod +x "$tmp/bin/"* "$tmp/home/.claude/bin/heavy"
printf '%s\n' "$token" >"$tmp/session"
chmod 600 "$tmp/session"

# A checkout as the build loop's has it: no package in web/node_modules, only Vite's cache.
checkout() {
  repo=$tmp/$1
  mkdir -p "$repo/.claude/workflows" "$repo/.github/workflows" "$repo/web/node_modules/.vite-temp"
  git init -q "$repo"
  cp "$here/look.sh" "$here/look.mjs" "$repo/.claude/workflows/"
  echo 'image: mcr.microsoft.com/playwright:v1.0.0-noble' >"$repo/.github/workflows/web.yml"
  touch "$repo/web/package-lock.json"
  export CALLS=$repo/calls SHOTS=$repo/out
  : >"$CALLS"
}
look() {
  status=0
  HOME=$tmp/home PATH=$tmp/bin:$PATH LOOK_ORIGIN=https://box.test LOOK_SESSION=${session:-$tmp/session} \
    bash "$repo/.claude/workflows/look.sh" "$repo/out" >"$repo/log" 2>&1 || status=$?
}
check() {
  if "${@:2}"; then return; fi
  echo "FAIL: $1" >&2
  sed 's/^/  /' "$CALLS" "$repo/log" >&2
  failed=1
}
calls() { grep -c -- "$1" "$CALLS" || true; }
installs_then_looks() {
  [ "$status" = 0 ] && [ "$(calls "^npm ci --prefer-offline in $repo/web\$")" = 1 ] &&
    [ "$(grep -n '^podman run ' "$CALLS" | cut -d: -f1)" -gt "$(grep -n '^npm ci ' "$CALLS" | cut -d: -f1)" ] &&
    [ "$(calls '^heavy npm$')" = 1 ] && [ "$(calls '^heavy podman$')" = 1 ] && grep -q 'home-desktop-chromium.png$' "$repo/log"
}
looks_without_install() { [ "$status" = 0 ] && [ "$(calls '^npm ')" = 0 ] && [ "$(calls '^podman run ')" = 1 ]; }
stops_before_the_browser() { [ "$status" = "$1" ] && [ "$(calls '^podman ')" = 0 ] && grep -q '^look: ' "$repo/log"; }

checkout bare
look
check "a checkout with no @playwright/test installs it under the lock, then runs the browser" installs_then_looks
check "the token is in no command's arguments" [ "$(calls "$token")" = 0 ]

: >"$CALLS"
look
check "a checkout that has the package does not install again" looks_without_install

: >"$CALLS"
touch -d '2001-01-01' "$repo/web/node_modules/.package-lock.json"
look
check "a lockfile newer than the install installs again" installs_then_looks

checkout offline
NPM_FAILS=1 look
check "a failed install ends the look with its reason and runs no browser" stops_before_the_browser 1

checkout unsigned
session=$tmp/none look
check "no session ends the look with exit 3 before the lock" stops_before_the_browser 3
check "no session takes no lock" [ "$(calls '^heavy ')" = 0 ]

[ "$failed" = 0 ] && echo "look.test.sh: ok"
exit "$failed"
