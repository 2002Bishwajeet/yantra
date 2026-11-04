#!/bin/sh
# Starts this Mac's tmux server in the login session, through a LaunchAgent
# (ADR-0018 §7 and its 2026-11-04 amendment, Y-632). tmux.rs sends it to a Mac
# with no server, and join.sh holds a copy. Both call `login_server <tmux>`.
#
# It returns 3 when no one is logged in at the screen: there is then no gui
# domain to load the job into. It returns 1 when the server did not start.
login_server() {
    tmux=$1
    domain=gui/$(id -u)
    launchctl print "$domain" >/dev/null 2>&1 || return 3
    label=io.github.2002bishwajeet.yantra-tmux
    plist=$HOME/Library/LaunchAgents/$label.plist
    log=$HOME/Library/Logs/yantra-tmux.log
    if ! [ -e "$plist" ]; then
        mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" || return 1
        # A second `tmux -D` on a held socket exits 1, which KeepAlive restarts
        # every 10 s, so `ls` ends the job with 0 there. Measured on tmux 3.8.
        cat >"$plist" <<PLIST || return 1
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>"\$0" ls >/dev/null 2>/dev/null || exec "\$0" -D</string><string>$tmux</string></array>
    <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
    fi
    # `kill-server` also ends `-D` with 0, so the kickstart is what restarts it.
    launchctl print "$domain/$label" >/dev/null 2>&1 ||
        launchctl bootstrap "$domain" "$plist" || return 1
    launchctl kickstart "$domain/$label" || return 1
    for _ in 1 2 3 4 5; do
        "$tmux" ls >/dev/null 2>&1 && return 0
        sleep 1
    done
    printf 'the tmux server did not start, and %s may say why\n' "$log" >&2
    return 1
}
