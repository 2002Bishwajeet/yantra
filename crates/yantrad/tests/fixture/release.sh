#!/usr/bin/env bash
#
# github.com and api.github.com, inside the container, so install.sh can be run
# against a release that this fixture publishes (Y-158). Real curl, real TLS,
# real checksums, a real signature of them by each channel's key, a release list
# to resolve a version from, and a corrupted, unsigned, forged or cross-signed
# release on demand — which the real host cannot serve.
#
# What it does not prove is that a published archive is shaped this way; the
# test asserts that against release.yml instead.
set -euo pipefail

WWW=/srv/www
STAGING=/srv/staging
UNITS=/srv/units
CERT=/srv/fixture.crt
KEY=/srv/fixture.key
STABLE=/srv/signing-stable
NIGHTLY=/srv/signing-nightly

case "$(uname -m)" in
aarch64 | arm64) target=aarch64-unknown-linux-musl other=x86_64-unknown-linux-musl ;;
x86_64 | amd64) target=x86_64-unknown-linux-musl other=aarch64-unknown-linux-musl ;;
*) echo "release.sh: no release is built for $(uname -m)" >&2 && exit 1 ;;
esac

# $2 is a version, or `nightly` for the rolling release.
downloads() {
    case "$2" in
    nightly) echo "$WWW/$1/releases/download/nightly" ;;
    *) echo "$WWW/$1/releases/download/v$2" ;;
    esac
}
staged() { echo "yantra-$1-$target"; }

# install.sh carries release.yml's two keys, which the fixture cannot sign with (Y-803).
trust() {
    sed -i -e "s|^STABLE_KEY=.*|STABLE_KEY='$(cut -d ' ' -f 1,2 "$STABLE.pub")'|" \
        -e "s|^NIGHTLY_KEY=.*|NIGHTLY_KEY='$(cut -d ' ' -f 1,2 "$NIGHTLY.pub")'|" "$1"
}

# The `sign` job's step, with the key $1. ssh-keygen asks before it replaces a signature.
sign() {
    rm -f SHA256SUMS.sig
    ssh-keygen -q -Y sign -f "$1" -n file SHA256SUMS
}

serve() {
    # Its own trust anchor, which is why it carries CA:TRUE: install.sh pins
    # `--proto '=https'` and a shim would leave that unexercised.
    #
    # raw.githubusercontent.com stays although nothing fetches it any more
    # (Y-365): a unit fetch that came back would answer 404 here rather than
    # succeed quietly against the real host.
    openssl req -x509 -newkey rsa:2048 -noenc -days 1 -keyout "$KEY" -out "$CERT" \
        -subj '/CN=yantra install fixture' \
        -addext 'basicConstraints=critical,CA:TRUE' \
        -addext 'subjectAltName=DNS:github.com,DNS:api.github.com,DNS:raw.githubusercontent.com' 2>/dev/null
    cp "$CERT" /etc/pki/ca-trust/source/anchors/yantra-fixture.crt
    update-ca-trust

    printf '127.0.0.1 github.com api.github.com raw.githubusercontent.com\n' >> /etc/hosts

    ssh-keygen -q -t ed25519 -N '' -f "$STABLE"
    ssh-keygen -q -t ed25519 -N '' -f "$NIGHTLY"
    trust /fixture/install.sh

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

# A fourth argument is a real yantrad to publish in place of the stand-in, for
# the update test that has to run the daemon it installed (Y-368). A fifth is a
# real yantra, for the test that needs `yantra ssh-identity` to run (Y-598).
publish() {
    local repo=$1 version=$2 marker=$3 daemon=${4:-} cli=${5:-}
    local stage binary unit
    stage=$(staged "$version")

    rm -rf "$STAGING" "$WWW/$repo" "$WWW/repos"
    mkdir -p "$STAGING/$stage" "$(downloads "$repo" "$version")" \
        "$WWW/repos/$repo/releases"

    # A real ELF, because the hazard the rename exists for is a file that is
    # being executed (Y-145) and nothing else answers ETXTBSY. `sleep` runs long
    # enough to be that file and is not what a release ships.
    for binary in yantrad yantra yantra-agent; do
        cp /usr/bin/sleep "$STAGING/$stage/$binary"
        if [ "$binary" = yantrad ] && [ -n "$daemon" ]; then
            cp "$daemon" "$STAGING/$stage/$binary"
        fi
        if [ "$binary" = yantra ] && [ -n "$cli" ]; then
            cp "$cli" "$STAGING/$stage/$binary"
        fi
        printf '\n%s\n' "$marker" >> "$STAGING/$stage/$binary"
    done
    echo "$marker" > "$STAGING/$stage/README.md"
    echo "$marker" > "$STAGING/$stage/LICENSE"

    # release.yml stages the units beside the binaries (Y-365), and install.sh
    # with them (Y-368). The marker is a comment, which is the one thing a unit
    # carries without systemd-analyze objecting, so an installed file names the
    # archive it came out of.
    for unit in yantrad.service yantra-agent.service yantra-update.path yantra-update.service; do
        {
            cat "$UNITS/$unit"
            echo "# $marker"
        } > "$STAGING/$stage/$unit"
    done
    {
        cat /fixture/install.sh
        echo "# $marker"
    } > "$STAGING/$stage/install.sh"

    # /releases/latest, which is the one read install.sh makes when nobody names
    # a version. `tag_name` is all it reads.
    printf '{"tag_name":"v%s","name":"v%s","draft":false,"prerelease":false}\n' \
        "$version" "$version" > "$WWW/repos/$repo/releases/latest"

    pack "$repo" "$version"
}

# The archive release.yml built, served under a version of the fixture's
# choosing (Y-483). Its units and binaries are left as built, and its install.sh
# differs in one line: the key. A marker, when there is one, is appended to each
# binary so that two publications of the same build are different files.
publish_archive() {
    local repo=$1 version=$2 marker=$3 archive=$4
    local stage built binary
    stage=$(staged "$version")

    rm -rf "$STAGING" "$WWW/$repo" "$WWW/repos"
    mkdir -p "$STAGING" "$(downloads "$repo" "$version")" "$WWW/repos/$repo/releases"
    tar -C "$STAGING" -xzf "$archive"

    built=("$STAGING"/yantra-*-"$target")
    if [ "${#built[@]}" -ne 1 ] || [ ! -d "${built[0]}" ]; then
        echo "release.sh: $archive holds no single yantra-*-$target directory" >&2
        exit 1
    fi
    [ "${built[0]}" = "$STAGING/$stage" ] || mv "${built[0]}" "$STAGING/$stage"

    if [ -n "$marker" ]; then
        for binary in yantrad yantra yantra-agent; do
            printf '\n%s\n' "$marker" >> "$STAGING/$stage/$binary"
        done
    fi

    printf '{"tag_name":"v%s","name":"v%s","draft":false,"prerelease":false}\n' \
        "$version" "$version" > "$WWW/repos/$repo/releases/latest"

    trust "$STAGING/$stage/install.sh"
    pack "$repo" "$version"
}

pack() {
    local repo=$1 version=$2 stage
    stage=$(staged "$version")
    cd "$(downloads "$repo" "$version")"
    tar -C "$STAGING" -czf "$stage.tar.gz" "$stage"
    sha256sum "$stage.tar.gz" > SHA256SUMS
    # The other architecture is in the published SHA256SUMS and is never
    # fetched, which is the whole of what install.sh's --ignore-missing is for.
    printf '%s  yantra-%s-%s.tar.gz\n' \
        0000000000000000000000000000000000000000000000000000000000000000 \
        "$version" "$other" >> SHA256SUMS
    sign "$STABLE"
}

# An archive shaped the way every release up to v0.1.0 is: three binaries and no
# units.
strip_units() {
    local repo=$1 version=$2
    rm -f "$STAGING/$(staged "$version")"/{*.service,*.path,install.sh}
    pack "$repo" "$version"
}

# An archive shaped the way v0.2.0 to v0.3.3 are: two units, and no updater.
strip_updater() {
    local repo=$1 version=$2
    rm -f "$STAGING/$(staged "$version")"/{yantra-update.*,install.sh}
    pack "$repo" "$version"
}

# A release list that answers 404, which is the branch a rate-limited 403 takes
# as well: no version resolves and nothing is installed.
unresolvable() {
    rm -f "$WWW/repos/$1/releases/latest"
}

# The publication served as the rolling nightly as well (Y-662): under the
# `nightly` tag, whose only version is in the title and the archives' names,
# and under the nightly key's signature (Y-803).
# The other target's archive is listed first, so a resolver must pick its own.
nightly() {
    local repo=$1 version=$2 rolling
    rolling=$(downloads "$repo" nightly)
    mkdir -p "$WWW/repos/$repo/releases/tags"
    rm -rf "$rolling"
    cp -r "$(downloads "$repo" "$version")" "$rolling"
    (cd "$rolling" && sign "$NIGHTLY")
    printf '{"tag_name":"nightly","name":"v%s","prerelease":true,"assets":[{"name":"yantra-%s-%s.tar.gz"},{"name":"yantra-%s-%s.tar.gz"},{"name":"SHA256SUMS"}]}\n' \
        "$version" "$version" "$other" "$version" "$target" > "$WWW/repos/$repo/releases/tags/nightly"
}

corrupt() {
    local repo=$1 version=$2
    printf x | dd of="$(downloads "$repo" "$version")/$(staged "$version").tar.gz" \
        bs=1 seek=0 conv=notrunc status=none
}

# A release that the `sign` job never reached.
unsign() {
    rm -f "$(downloads "$1" "$2")/SHA256SUMS.sig"
}

# A release that a key install.sh does not carry signed.
stranger() {
    rm -f /srv/stranger /srv/stranger.pub
    ssh-keygen -q -t ed25519 -N '' -f /srv/stranger
    cd "$(downloads "$1" "$2")"
    sign /srv/stranger
}

# A release under the other channel's signature (Y-803).
cross() {
    cd "$(downloads "$1" "$2")"
    if [ "$2" = nightly ]; then sign "$STABLE"; else sign "$NIGHTLY"; fi
}

# Another archive with a SHA256SUMS that matches it, under the signature of the first.
forge() {
    corrupt "$1" "$2"
    cd "$(downloads "$1" "$2")"
    sha256sum "$(staged "$2").tar.gz" > SHA256SUMS
}

"$@"
