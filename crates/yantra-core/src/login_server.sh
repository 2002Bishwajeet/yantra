#!/bin/sh
# Starts this Mac's tmux server in the login session, through a LaunchAgent
# (ADR-0018 §7 and its 2026-11-04 amendment, Y-632). tmux.rs sends it to a Mac
# with no server, and join.sh holds a copy. Both call `login_server <tmux>`.
# The server is the one named `yantra`, which only this job starts (Y-667).
# An older Yantra's `yantra-tmux` job and its default-socket server are never
# touched.
#
# It returns 3 when no one is logged in at the screen: there is then no gui
# domain to load the job into. It returns 1 when the server did not start.

# The PATH the account's login shell sets, so a pane finds what Terminal finds
# (Y-640), and then each fixed directory it lacks. An rc file can print escape
# codes, so the PATH is the line after a marker.
login_path() (
    # Also silences the shell's notice that the guard was killed.
    exec 2>/dev/null
    fixed=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
    found=
    if out=$(mktemp "${TMPDIR:-/tmp}/yantra-path.XXXXXX"); then
        "${SHELL:-/bin/sh}" -lic 'echo yantra-login-path; printenv PATH' </dev/null >"$out" &
        shell=$!
        # macOS has no timeout(1), and an interactive shell ignores TERM.
        (sleep 5 && kill -s KILL "$shell") >/dev/null &
        guard=$!
        wait "$shell"
        kill "$guard"
        found=$(awk 'seen { print; exit } /yantra-login-path/ { seen = 1 }' "$out")
        rm -f "$out"
    fi
    # The value goes into the plist unescaped. `(…)` because bash 3.2 ends a
    # `$(…)` at a bare pattern's `)`.
    case $found in
    (*[\<\>\&]*) found=$fixed ;;
    (/*) ;;
    (*) found=$fixed ;;
    esac
    set -f
    IFS=:
    for dir in $fixed; do
        case ":$found:" in
        (*":$dir:"*) ;;
        (*) found=$found:$dir ;;
        esac
    done
    printf '%s\n' "$found"
)

login_server() {
    tmux=$1
    domain=gui/$(id -u)
    launchctl print "$domain" >/dev/null 2>&1 || return 3
    label=io.github.2002bishwajeet.yantra-tmux-server
    plist=$HOME/Library/LaunchAgents/$label.plist
    log=$HOME/Library/Logs/yantra-tmux-server.log
    agent_path=$(login_path)
    # kill-server ends `-D` with 0, so KeepAlive is unconditional. A second `-D`
    # on a held socket exits 1, so the job waits out a server it did not start.
    # Interactive, so launchd puts no background limits on the panes' agents.
    job=$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>while "\$0" -L yantra ls >/dev/null 2>/dev/null; do sleep 10; done; exec "\$0" -L yantra -D</string><string>$tmux</string></array>
    <key>EnvironmentVariables</key><dict><key>PATH</key><string>$agent_path</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Interactive</string>
    <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
)
    # A plist an older Yantra wrote is replaced, and its job with it. The
    # bootout ends the server that job runs, so it waits until no session is held.
    if [ "$(cat "$plist" 2>/dev/null)" != "$job" ]; then
        if launchctl print "$domain/$label" >/dev/null 2>&1; then
            [ -n "$("$tmux" -L yantra -N ls 2>/dev/null)" ] && return 0
            launchctl bootout "$domain/$label" 2>/dev/null
        fi
        mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" || return 1
        printf '%s\n' "$job" >"$plist" || return 1
    fi
    launchctl print "$domain/$label" >/dev/null 2>&1 ||
        launchctl bootstrap "$domain" "$plist" || return 1
    launchctl kickstart "$domain/$label" || return 1
    for _ in 1 2 3 4 5; do
        "$tmux" -L yantra -N ls >/dev/null 2>&1 && return 0
        sleep 1
    done
    printf 'the tmux server did not start, and %s may say why\n' "$log" >&2
    return 1
}
