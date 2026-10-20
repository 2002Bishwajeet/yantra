#!/bin/sh
# The keeper of one Chat turn (ADR-0035 decision 2). tmux holds this script
# and the script holds the agent. It reads no protocol: it moves bytes from
# the journal `in` to the agent and from the agent to `out`, and it enforces
# two limits. keep.rs sends it base64-encoded each time; nothing is installed.
#
# Arguments: the journal directory, the cap on `out` in bytes, the idle limit
# in seconds, the agent's command in base64, and how often the watcher looks,
# in seconds.
d=$1 cap=$2 idle=$3 agent=$4 tick=${5:-60}
cd "$d" || exit 1
umask 077
: >>in
: >>out
rm -f feed
mkfifo feed || exit 1
# A file and not a fifo is the buffer; this fifo only joins `in` to stdin.
tail -n +1 -f in >feed &
echo $! >feed.pid
/bin/sh -c "$(echo "$agent" | base64 -d)" <feed >>out 2>>err &
a=$!
# Idle is measured by size, because both journals only grow. It needs no
# `find -mmin` and no `stat`, whose flags differ across the fleet (I-45).
(
  trap 'kill "$z" 2>/dev/null; exit 0' TERM
  was=
  quiet=0
  while :; do
    sleep "$tick" &
    z=$!
    wait "$z"
    size=$(($(wc -c <out)))
    if [ "$size" -gt "$cap" ]; then
      echo "yantra: output passed $cap bytes" >>err
      kill "$a" 2>/dev/null
    fi
    now="$(($(wc -c <in))) $size"
    if [ "$now" = "$was" ]; then
      quiet=$((quiet + tick))
      if [ "$quiet" -ge "$idle" ]; then
        echo "yantra: idle for $idle seconds" >>err
        kill "$a" 2>/dev/null
      fi
    else
      quiet=0
      was=$now
    fi
  done
) &
w=$!
wait "$a"
s=$?
kill "$w" "$(cat feed.pid)" 2>/dev/null
rm -f feed feed.pid
exit "$s"
