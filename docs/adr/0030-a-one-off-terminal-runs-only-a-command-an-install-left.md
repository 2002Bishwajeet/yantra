# ADR-0030 — A one-off terminal runs only a command an install left

- **Date:** 2026-09-13
- **Status:** Accepted by delegation, 2026-09-13. The owner delegated the decisions of
  [Y-394](../../tracker.md) (*"take decisions, run tests, design ui"*), and this records them.
- **Reads against** [ADR-0028](0028-yantra-installs-the-bare-minimum-on-a-machine.md) §5 and its
  Y-394 note, [ADR-0022](0022-a-socket-may-address-a-session-rather-than-a-workspace.md) for the
  socket, [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md) for who
  may open it, and [ADR-0012](0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md) for
  the CLI's side.

## Context

The owner decided on 2026-09-12 (ADR-0028 §5, dated note): when an install step needs sudo and
sudo wants a password, the dashboard opens a one-off terminal on that machine. The terminal runs
the command the install result names. The person types the password there, and it passes only as
keystrokes.

That leaves one question open: **what may such a terminal run?** Three facts bound the answer.

- **A socket that takes a command string is a remote shell by another name.** Any caller that
  `allowed()` admits could run anything on any machine, without a pane to show it.
- **`allowed()` already hands its caller a shell.** ADR-0022 lets it attach to any tmux session,
  and a person there can type anything. So a narrow rule here is defence in depth. It is not the
  only line, and this ADR does not claim that it is.
- **It cannot be a tmux session.** `tmux` can be the thing being installed (ADR-0028 §4).

## Decision

1. **The daemon remembers the `commands` of the latest install result on each machine**, in
   memory, keyed on the lowercased name as the install lock is. The next result on that machine
   replaces the list, and a result that left nothing empties it. A restart forgets it, as it
   forgets the events (ADR-0025).
2. **The socket takes an index into that list, and nothing else can run.**
   `GET /api/machines/{machine}/install/{index}/terminal` calls `allowed()` before the upgrade, as
   every terminal route does. A name outside the ssh-destination rule is a `400` before the
   upgrade. An index outside the list, or a machine with no remembered result, is refused by name
   in a text frame after the upgrade, as ADR-0022 §5 refuses a session that is not there.
3. **It is `ssh -tt <machine> <command>` under `pty.rs`**: the system `ssh`, the same multiplexed
   connection as every other call (I-20), and no tmux. The command reaches the far login shell as
   `TERM=<t> /bin/sh -c '<command>'`, quoted with `tmux::sq`, with a `TERM` that `terminfo::choose`
   found there.
4. **The password is keystrokes and nothing else.** It crosses the socket as binary frames and
   goes into the pty. Nothing reads it, stores it or logs it. The route logs the lifecycle and
   never the stream (Q5), as `terminal.rs` already does.
5. **The terminal ends when the command does.** The daemon sends `{"exit": n}` as a text frame and
   closes. `n` is the exit status `ssh` reported, or `null` where none could be read. **The browser
   never reopens this socket**, because a reopened socket runs the command again.
6. **No CLI verb.** `yantra install` already prints each command it left, and a person at a CLI is
   already at a terminal. The route is a terminal, as `yantra attach`'s is, so ADR-0012's test
   holds.

## Consequences

- **It narrows one route, not the authoriser.** A caller `allowed()` admits can still attach to
  any shell on the fleet (ADR-0022). What this adds is that the one-off route cannot be steered
  into running a command Yantra did not write.
- **An index can go stale in one narrow window.** The list changes when another install on that
  machine ends, and the page reads the new event within one poll (5 s). An index can point at a
  command the page has not drawn yet only if a second install ended in that window. The daemon
  runs what it holds, and the pane shows it running.
- **A restart empties the list.** The refusal says so, and pressing Install again fills it.
- **Closing the sheet stops the command.** Dropping the pty hangs up the far side (I-27's
  terminal half), so a person who closes it mid-install stops sudo there.
- **The daemon offers every remembered command; the page offers the sudo ones.** A root-only step
  run as Yantra's account would only fail, so the page offers a terminal where `install.rs` put
  `sudo` in front.

## Alternatives

- **A password box.** The owner refused it on 2026-09-12. A password handled as a value is the
  thing ADR-0028 §5 exists to prevent.
- **The command string on the socket.** Refused above: it makes the route a remote shell that
  shows nothing.
- **A tmux session running the command.** Refused: `tmux` may be what is missing.
