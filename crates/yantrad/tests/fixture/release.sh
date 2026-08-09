#!/usr/bin/env bash
#
# github.com and raw.githubusercontent.com, inside the container, so install.sh
# can be run against a release that this fixture publishes (Y-158). Real curl,
# real TLS, real checksums, and a corrupted archive on demand — which the real
# host cannot serve.
#
# What it does not prove is that a published archive is shaped this way; the
# test asserts that against release.yml instead.
set -euo pipefail

WWW=/srv/www
STAGING=/srv/staging
UNITS=/srv/units
CERT=/srv/fixture.crt
KEY=/srv/fixture.key

case "$(uname -m)" in
aarch64 | arm64) target=aarch64-unknown-linux-musl other=x86_64-unknown-linux-musl ;;
x86_64 | amd64) target=x86_64-unknown-linux-musl other=aarch64-unknown-linux-musl ;;
*) echo "release.sh: no release is built for $(uname -m)" >&2 && exit 1 ;;
esac

downloads() { echo "$WWW/$1/releases/download/v$2"; }
staged() { echo "yantra-$1-$target"; }

serve() {
    # Its own trust anchor, which is why it carries CA:TRUE: install.sh pins
    # `--proto '=https'` and a shim would leave that unexercised.
    openssl req -x509 -newkey rsa:2048 -noenc -days 1 -keyout "$KEY" -out "$CERT" \
        -subj '/CN=yantra install fixture' \
        -addext 'basicConstraints=critical,CA:TRUE' \
        -addext 'subjectAltName=DNS:github.com,DNS:raw.githubusercontent.com' 2>/dev/null
    cp "$CERT" /etc/pki/ca-trust/source/anchors/yantra-fixture.crt
    update-ca-trust

    printf '127.0.0.1 github.com raw.githubusercontent.com\n' >> /etc/hosts

    mkdir -p "$WWW"
    echo ready > "$WWW/ready"
    systemd-run --unit=release-server --collect \
        python3 /fixture/server.py "$WWW" "$CERT" "$KEY"

    for _ in $(seq 50); do
        if curl -fsS --proto '=https' --tlsv1.2 https://github.com/ready >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.2
    done
    echo "release.sh: the release host never answered" >&2
    journalctl -u release-server --no-pager >&2
    exit 1
}

publish() {
    local repo=$1 version=$2 commit=$3 marker=$4
    local stage raw
    stage=$(staged "$version")
    raw="$WWW/$repo/$commit/crates"

    rm -rf "$STAGING" "$WWW/$repo"
    mkdir -p "$STAGING/$stage" "$(downloads "$repo" "$version")" \
        "$raw/yantrad" "$raw/yantra-agent"

    # A real ELF, because the hazard the rename exists for is a file that is
    # being executed (Y-145) and nothing else answers ETXTBSY. `sleep` runs long
    # enough to be that file and is not what a release ships.
    local binary
    for binary in yantrad yantra yantra-agent; do
        cp /usr/bin/sleep "$STAGING/$stage/$binary"
        printf '\n%s\n' "$marker" >> "$STAGING/$stage/$binary"
    done
    echo "$marker" > "$STAGING/$stage/README.md"
    echo "$marker" > "$STAGING/$stage/LICENSE"

    cp "$UNITS/yantrad.service" "$raw/yantrad/"
    cp "$UNITS/yantra-agent.service" "$raw/yantra-agent/"

    cd "$(downloads "$repo" "$version")"
    tar -C "$STAGING" -czf "$stage.tar.gz" "$stage"
    sha256sum "$stage.tar.gz" > SHA256SUMS
    # The other architecture is in the published SHA256SUMS and is never
    # fetched, which is the whole of what install.sh's --ignore-missing is for.
    printf '%s  yantra-%s-%s.tar.gz\n' \
        0000000000000000000000000000000000000000000000000000000000000000 \
        "$version" "$other" >> SHA256SUMS
}

corrupt() {
    local repo=$1 version=$2
    printf x | dd of="$(downloads "$repo" "$version")/$(staged "$version").tar.gz" \
        bs=1 seek=0 conv=notrunc status=none
}

"$@"
