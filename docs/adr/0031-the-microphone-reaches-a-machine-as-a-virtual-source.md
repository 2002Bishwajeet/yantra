# ADR-0031 — The microphone reaches a machine as a virtual source that only Yantra's sessions hear

- **Date:** 2026-09-29
- **Status:** Accepted 2026-09-29. The owner took decisions 1 to 8 that day ([Y-415](../../tracker.md)).
  Decision 3 amended 2026-10-05 ([Y-417](../../tracker.md)).
- **Evidence:** [R17](../research/17-remote-microphone.md), 2026-09-29. Its §7 was measured for
  this ADR.
- **Extends** [ADR-0028](0028-yantra-installs-the-bare-minimum-on-a-machine.md) §1 through the
  optional install that its §3 left for later.
- **Reads against** [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)
  for who may send audio, [ADR-0030](0030-a-one-off-terminal-runs-only-a-command-an-install-left.md)
  for the sudo steps, and [ADR-0026](0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) for a
  daemon-side bridge to a process over ssh.

## Context

The owner cannot talk to an agent on a remote machine. Claude Code's voice dictation records from
the machine where it runs, and a fleet machine has no microphone. R17 found that this is a missing
device, not a switch that ssh turns off (R17, negative finding 1). On a headless Linux machine Claude
Code spawns `arecord` on ALSA's `default` (finding 2). So a virtual input device on the machine is
enough, and PipeWire already provides one: a null sink plus a remap source (R17 §2).

R17 left eight decisions open. The owner took them on 2026-09-29. One of them, *not the machine's
default input*, needed a mechanism that R17 had not tested. R17 §7 measured it before this ADR was
written.

## Decision

### 1. Install sets the machine up (Linux)

The microphone is the **first optional item** on ADR-0028's Install, chosen per machine. It
installs PipeWire's audio stack and writes the virtual mic's config:

- **Packages:** `pipewire pipewire-pulse wireplumber pipewire-alsa pulseaudio-utils alsa-utils` on
  apt (R17 §2, verified). The other package managers get their own names for the same set, as a
  constant in `yantra-core`, as ADR-0028 §1's list is. Only the apt names were tested.
- **Config:** the per-user drop-in `~/.config/pipewire/pipewire-pulse.conf.d/yantra-mic.conf` from
  R17 §2, which makes `yantra-mic-sink` and the source `yantra-mic`. Writing it needs no root.
- Install follows ADR-0028 §5: `sudo -n` in the background, and a one-off terminal (ADR-0030) when
  sudo wants a password.

### 2. Linger is on for each machine that hears the mic

Linger tells systemd to keep a user's services running when that user is not logged in. Without it,
PipeWire stops at logout and the mic disappears (R17 §2). Install leaves
`sudo loginctl enable-linger <user>` as one of its commands, which the one-off terminal runs. The
appliance runs no audio and needs nothing.

### 3. The virtual mic is the default only in sessions Yantra starts

Yantra never runs `pactl set-default-source`. It starts the agent with
**`PIPEWIRE_NODE=yantra-mic`** in its environment. `pipewire-alsa` reads that variable, so ALSA's
`default` records from `yantra-mic` for that process and its children, and for no other program.
R17 §7 verified this for Claude Code's `arecord` line and for SoX `rec`, inside and outside `tmux`,
with the default source unchanged. `PULSE_SOURCE` does not work for this, and neither does a
`~/.asoundrc`, which changes the default for every program.

The variable is exported in the agent's start command, in the same place as the musl
`USE_BUILTIN_RIPGREP=0` (ADR-0028 §5, note of 2026-09-12). A shell pane in a Yantra session that
must hear the mic sets the same variable.

> **Amended 2026-10-05 ([Y-417](../../tracker.md)).** The owner runs `claude` in a plain `ssh`
> shell, not only in sessions Yantra starts. That shell does not carry `PIPEWIRE_NODE`, so it
> heard nothing. The owner chose this change: **on a machine with no sound card, Install runs
> `pactl set-default-source yantra-mic`.** "No sound card" is the test Claude Code itself uses:
> `/proc/asound/cards` is missing, empty, or says `no soundcards` (R17 §1). Such a machine has no
> other input, so no program loses a microphone. WirePlumber keeps the choice across a reboot
> (R17 §2). A machine with a sound card keeps the rule above, and its owner exports the variable
> in their own shell. Install checks once; a card added later does not change the default.

### 4. The browser sends raw 16 kHz mono s16le PCM

The dashboard captures with `getUserMedia` and an AudioWorklet, and sends binary WebSocket frames of
16 kHz, signed 16-bit, little-endian, mono PCM. There is no Opus. This is the format Claude Code
records in, it needs no decoder on the machine, and it costs 256 kbit/s, which fits R16's phone
profile (R17 §5). The microphone works only on the HTTPS origin at `:8443`. On `:7717` the button
says why it is unavailable.

### 5. The mic is a write

`yantrad` gets a microphone WebSocket per machine. It calls `allowed()` before the upgrade, as every
terminal route does (ADR-0016). The daemon spawns one `ssh <machine>` running
`XDG_RUNTIME_DIR=/run/user/$(id -u) pw-cat --playback --raw --target yantra-mic-sink --format s16
--rate 16000 --channels 1 -` over the multiplexed connection (I-20). It copies each binary frame to
that process's stdin. It uses no pty, because a pty changes bytes. It keeps no buffer beyond the
pipe.

**No audio byte is ever logged.** The route logs the lifecycle and never the stream, which is Q5's
rule for a terminal stream.

### 6. Push-to-talk

The person holds a button in the dashboard. The press opens the microphone and the socket. The
release closes both, and closing stdin ends `pw-cat`. The microphone is never open while the button
is up. When iOS or the browser takes the microphone away, the button shows that the stream stopped.

### 7. `yantra mic <machine>` streams one way (R17 recipe B)

The CLI verb runs, on the laptop:

```sh
pw-record --raw --format s16 --rate 16000 --channels 1 - \
  | ssh <machine> 'XDG_RUNTIME_DIR=/run/user/$(id -u) pw-cat --playback --raw --target yantra-mic-sink --format s16 --rate 16000 --channels 1 -'
```

It streams until Ctrl-C. It needs decision 1 on the machine, and it needs nothing more: a session
that Yantra started already carries decision 3's variable.

**Recipe A, the forwarded Pulse socket, is not built.** Two reasons:

- It gives the remote account the laptop's whole audio server. Any process of that account can
  record the laptop's microphone at any time while the connection is up (R17 finding 6). R17 offers
  no mitigation except *"use it only with machines you trust as much as the laptop"*.
- The remote recorder reaches that socket only through a `pcm.!default { type pulse }` in
  `~/.asoundrc`. That changes the default input for every program, which decision 3 forbids.

The cost of recipe B is that the laptop's microphone is open for the whole run, not only while a key
is held. Nothing on the machine can reach the laptop.

### 8. macOS

macOS is in scope. **Decision 3 cannot hold there.** Claude Code's native module opens the system
default input and reads no device variable (R17 §1 and §7). It falls back to `rec` only when the
module fails to load, which it does not on a working Mac.

| Step | Who | Why |
|---|---|---|
| `brew install blackhole-2ch`, then `sudo killall -9 coreaudiod` | Install, through the one-off terminal | The driver needs admin rights (R17 §3) |
| `brew install sox`, the writer (`sox … -t coreaudio "BlackHole 2ch"`) | Install | Playback needs no permission (R17 §3) |
| Make BlackHole 2ch the Mac's input in System Settings | **The person, guided by the dashboard** | It changes the input for the whole Mac. Yantra does not make that change for them (decision 3) |
| Allow microphone access for the app that started the tmux server | **The person, at the Mac** | TCC asks on the Mac's screen. A process started by `sshd` is billed to `sshd-keygen-wrapper`, whose prompt nobody sees (R17 §3) |

**Nothing here was tested on a Mac.** That includes the claim that a tmux server started from
Terminal.app is billed to Terminal.app.

### 9. `doctor` checks the mic

A new check asks `pactl` under `XDG_RUNTIME_DIR` whether the source `yantra-mic` exists (R17 §6). On
a machine where the mic was not installed, the check says so and does not make the machine unready.
A machine without linger fails the check after logout, and the check names linger as the cause.

## Consequences

- **Yantra installs an audio server on a machine when a person asks.** ADR-0028's list of what Yantra
  is for is unchanged, and the mic stays optional per machine.
- **Only programs that Yantra starts hear the mic.** A person who runs `claude` in their own ssh
  shell must export `PIPEWIRE_NODE=yantra-mic` themselves.
- **The session hears the mic only while Claude Code records.** Claude Code opens `arecord` only
  while its own voice key is held or toggled. Nothing links that key to the dashboard's button, so
  the person presses both.
- **One daemon-side stream per press.** The ssh connection is multiplexed, so the start cost is one
  channel, and the pipe holds the first frames until `pw-cat` reads them.
- **macOS changes the whole Mac's input**, by the person's own hand. The dashboard says so before it
  shows that step.

## Left open

- **The null sink is the default sink on a machine with no other sink** (R17 §2). Anything that
  machine plays then goes into the mic. R17 §7 showed that the leak comes from the default sink and
  not from the variable. [Y-417](../../tracker.md) decides how to keep `yantra-mic-sink` from being
  the default.
- **Package names on `dnf`, `pacman`, `zypper` and `apk`** are not verified. Alpine has no systemd
  user manager, so linger means nothing there.
- **A desktop that runs PulseAudio itself** has no `pipewire-alsa`, and `PIPEWIRE_NODE` does nothing
  there. Not tested.
- **Latency end to end** and a phone relayed through DERP are not measured (R17 §5).
- **Tailscale SSH and `XDG_RUNTIME_DIR`**: the writer sets the variable itself, so this should not
  matter. Not re-tested.
