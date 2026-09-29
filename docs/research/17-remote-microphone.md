# R17 — A microphone that reaches the remote machine

**Asked 2026-09-29 by the owner (Y-415).** The owner cannot talk to a remote agent. They want their
microphone to reach a fleet machine as an input device that **Claude Code's voice dictation** and
**any other program** can record from. Two clients must work: the dashboard in a browser (phone, iPad,
laptop), and plain `ssh` from the owner's CachyOS laptop.

Every claim below says whether it was **verified** here, **read in the shipped code**, or only
**documented**. Claude Code changes weekly. Treat §1 as true for 2.1.284 and re-check it.

## Negative findings first

1. **The docs say voice dictation does not work in SSH sessions. The code does not check for SSH.**
   The Linux build of 2.1.284 gates on two things only: a cloud-session flag (`$b()`, which is the
   constant `false` in this build) and `CLAUDE_CODE_REMOTE`. It never reads `SSH_CONNECTION`. The
   docs mean *"the remote host has no microphone"*, not *"voice is switched off over ssh"*. Give the
   remote host an input device and the same code records from it. (Read in the code; §1.)
2. **On a headless Linux box Claude Code does not use its native module.** It uses it only if
   `/proc/asound/cards` exists and lists a card. A VM or a server has no cards, so Claude Code spawns
   `arecord` — and `arecord` reads the ALSA `default` PCM. Everything in this note works through that
   one fact. (Read in the code; the Debian 13 VM has no `/proc/asound/cards`, verified.)
3. **A PipeWire "virtual source" that looks right does not work.**
   `pactl load-module module-null-sink media.class=Audio/Source/Virtual …` makes a source that
   `arecord` records from, but **neither `pw-cat --target` nor `pacat -d` can write into it.** WirePlumber
   links both writers to another sink and the recorder hears silence. The pair that works is a
   **null sink plus `module-remap-source`** on its monitor. (Verified, §2.)
4. **`PULSE_SERVER` alone does not redirect `arecord`.** On a host with `pipewire-alsa`, ALSA's
   `default` goes to PipeWire's native socket and ignores `PULSE_SERVER`. A `~/.asoundrc` that makes
   `default` the `pulse` plugin is required. (Verified, §4.)
5. **A forwarded Unix socket blocks the next connection.** `ssh -R /path:…` leaves the socket file
   behind. The next `ssh -R` to the same path fails, because the *remote* `sshd` decides
   `StreamLocalBindUnlink` and its default is `no`. The client-side option does not help for `-R`.
   (Verified, §4.)
6. **Forwarding the laptop's Pulse socket gives the remote machine the whole audio server.** While the
   connection is up, any process of that remote account can record the laptop's microphone at any
   time, play sound, and load modules. (Documented property of the Pulse protocol; the remote client
   showed up on the laptop as `application.process.host = "yantra-qa"`, verified.)
7. **macOS is impractical to automate.** It needs a third-party audio driver installed by an admin,
   a change of the system default input, and a microphone permission that only a person at the Mac
   can grant. Over plain ssh the permission is billed to `sshd-keygen-wrapper`, and nobody at the
   screen answers its prompt. (Documented and read in the code; **no Mac was tested**. §3.)
8. **`http://…:7717` cannot use the microphone.** `getUserMedia` needs a secure context; on plain
   HTTP `navigator.mediaDevices` is `undefined`. Only the `tailscale serve` HTTPS address on `:8443`
   works. (Documented, §5.)
9. **Sending 48 kHz raw PCM from a phone is too much.** It is 768 kbit/s, above the 750 kbit/s upload
   of the mobile profile that [R16](16-what-the-first-load-costs-a-phone.md) measures against. At
   16 kHz it is 256 kbit/s, and 16 kHz is what Claude Code records anyway. (Arithmetic, §5.)

## 1. How Claude Code records audio (2.1.284, 2026-09-29)

**Documented** ([voice dictation](https://code.claude.com/docs/en/voice-dictation)): audio goes to
Anthropic for transcription; it needs a Claude.ai login; *"Audio recording uses a built-in native
module on macOS, Linux, and Windows. On Linux, if the native module cannot load, Claude Code falls
back to `arecord` from ALSA utils or `rec` from SoX."* There is **no setting or environment variable
to choose a device**. The troubleshooting section says to fix *"the system default"* input.

**Read in the code.** The Linux binary (`~/.local/share/claude/versions/2.1.284`) and the macOS arm64
binary (downloaded from `downloads.claude.ai/claude-code-releases/2.1.284/darwin-arm64/claude`) both
carry `audio-capture.node`. Strings in it name `cpal` with its ALSA host on Linux, and `AudioUnit`,
`AudioQueueNewInput` and `AVCaptureDevice` on macOS. `cpal` opens the system default input on both.

The Linux recorder, from the bundled JavaScript:

| Step | Condition | What runs |
|---|---|---|
| 0 | `$b()` or `CLAUDE_CODE_REMOTE` set | refuse: *"no audio device is available in this environment"* |
| 1 | native module loads **and** `/proc/asound/cards` is non-empty and not `no soundcards` | native `cpal`, ALSA `default` |
| 2 | `arecord --version` works, and a 150 ms probe `arecord -f S16_LE -r 16000 -c 1 -t raw /dev/null` exits 0 or is still running | `arecord -f S16_LE -r 16000 -c 1 -t raw -q -` |
| 3 | `sox --version` and `rec --version` work | `rec -q --buffer 1024 -t raw -r 16000 -e signed -b 16 -c 1 - [silence …]` |

**16 kHz, signed 16-bit, mono** is the format on every path. Each recording spawns a fresh `arecord`,
so a new default source applies to the next press of the key without a restart. The macOS build has
the same shape with `platform=darwin`: the native module first, then `rec` from SoX.

**Observed and not explained:** both builds declare `~/.cache/coder-audio/port`, `…/token` and an
`activeForwardedSocket` field beside the recorders. Nothing in the Linux recorder reads them. It
looks like work toward forwarded audio. Nothing here should depend on it.

**Not tested:** Claude Code itself on the VM. That needs the owner's Claude.ai login, and the VM has
none. The test below uses Claude Code's exact `arecord` command line instead.

## 2. A virtual microphone on Linux, without root

### What works (verified on Debian 13, PipeWire 1.4.2, WirePlumber 0.5.8)

A **null sink** that a writer plays into, and a **remap source** on that sink's monitor that programs
record from. Both are PulseAudio modules, so the same two lines work on a real PulseAudio host.

```sh
pactl load-module module-null-sink sink_name=yantra-mic-sink channel_map=mono rate=48000 \
  sink_properties=device.description=Yantra-microphone-input
pactl load-module module-remap-source master=yantra-mic-sink.monitor source_name=yantra-mic \
  channel_map=mono source_properties=device.description=Yantra-microphone
pactl set-default-source yantra-mic
```

To make it survive a restart without root, put it in
`~/.config/pipewire/pipewire-pulse.conf.d/yantra-mic.conf`:

```
pulse.cmd = [
  { cmd = "load-module" args = "module-null-sink sink_name=yantra-mic-sink channel_map=mono rate=48000 sink_properties=device.description=Yantra-microphone-input" flags = [ ] }
  { cmd = "load-module" args = "module-remap-source master=yantra-mic-sink.monitor source_name=yantra-mic channel_map=mono source_properties=device.description=Yantra-microphone" flags = [ ] }
]
```

WirePlumber stores the default source in `~/.local/state/wireplumber/default-nodes`
(`default.configured.audio.source=yantra-mic`), so `set-default-source` survives a reboot too.

**The writer**, run over ssh with PCM on stdin. Either works; both were verified:

```sh
ssh host 'pw-cat --playback --raw --target yantra-mic-sink --format s16 --rate 16000 --channels 1 -'
ssh host 'pacat --playback --raw -d yantra-mic-sink --format=s16le --rate=16000 --channels=1'
```

`pw-cat` needs `--raw` to read stdin; without it `-` is opened as a sound file and fails with
`Format not recognised`.

**The test.** A 440 Hz sine, 3 s, s16 mono 48 kHz, generated on the laptop and piped through
`ssh` into `pw-cat`. On the VM, `arecord -f S16_LE -r 16000 -c 1 -t raw -q` — Claude Code's
command — ran in the background, and once more inside a detached `tmux` session. Both captured RMS
8484 (= 12000/√2) at 440.0 Hz between silent edges. Both writers passed. The run was repeated at
16 kHz in, with the writer setting `XDG_RUNTIME_DIR=/run/user/$(id -u)` itself: same result.

### The package set for a headless box

On the Debian 13 cloud image, which had no audio stack at all:

```sh
sudo apt-get install --no-install-recommends \
  pipewire pipewire-pulse wireplumber pipewire-alsa pulseaudio-utils alsa-utils
```

`pipewire-alsa` makes ALSA's `default` PCM go to PipeWire (`/etc/alsa/conf.d/99-pipewire-default.conf`).
`pulseaudio-utils` gives `pactl` and `pacat`; `pipewire-bin` (pulled in) gives `pw-cat`.
**Installing needs root. Everything after that is per user and does not.**

### The login session

PipeWire runs as the user's `systemd --user` services and listens in `$XDG_RUNTIME_DIR`. So:

- **An ssh login is enough** while it lasts: `pam_systemd` starts the user manager, the sockets
  activate `pipewire` and `pipewire-pulse` on first use.
- **`loginctl enable-linger <user>` keeps them with nobody logged in.** Verified: after a reboot with
  linger on, `pipewire`, `pipewire-pulse` and `wireplumber` were active from boot, before any login,
  and `yantra-mic-sink` and `yantra-mic` existed. Debian enables the three user units by default.
  Enabling linger is `sudo`, once.
- **Tailscale SSH** did not set `XDG_RUNTIME_DIR` for a command in 2022
  ([tailscale#5715](https://github.com/tailscale/tailscale/issues/5715), closed 2023-02-18). Not
  re-tested. A writer that sets `XDG_RUNTIME_DIR=/run/user/$(id -u)` itself does not depend on it.
  This is the same class of problem as the doctor's `login-session` check: the audio server lives in
  the user's session, not in the ssh process.

### Side effects to decide on

- **The null sink becomes the default sink** on a box with no other sink (verified:
  `pactl get-default-sink` answers `yantra-mic-sink`). Anything the machine plays — a bell, a
  text-to-speech tool — then goes into the microphone.
- **On a desktop Linux machine the virtual source replaces the person's real microphone** as default
  for every program. Not tested on a desktop; it follows from how default sources work.
- **With no writer connected, the source is silence.** Claude Code then says *"No audio detected from
  microphone"*.

## 3. macOS

There is no Pulse server. A virtual input needs an audio driver.

- **[BlackHole](https://github.com/ExistentialAudio/BlackHole)**: GPL-3.0, free.
  `brew install blackhole-2ch` or a `.pkg`. It is a HAL plug-in in `/Library/Audio/Plug-Ins/HAL/`,
  not a kernel extension, so there is no approval in Security settings. It needs admin rights and
  `sudo killall -9 coreaudiod` (or a restart) to appear.
- **Loopback** by Rogue Amoeba: a paid licence and its own driver installer. Not examined further.

**Writing into it** is playback, and playback is not behind a permission. SoX can play to a Core
Audio device by name: `sox -t raw -r 16000 -e signed -b 16 -c 1 - -t coreaudio "BlackHole 2ch"`
(SoX documentation; not run). Making it the default input needs a tool such as `SwitchAudioSource`
from `brew install switchaudio-osx`, which changes it for the whole Mac.

**Recording from it is behind the microphone permission (TCC), even though the device is virtual.**
TCC bills the *responsible process*. A process started by `sshd` is billed to
`/usr/libexec/sshd-keygen-wrapper`
([jStack#239](https://github.com/jenyalebid/jStack/issues/239), 2026-09-28), and the prompt appears on
the Mac's screen, where nobody is. [ADR-0018](../adr/0018-the-tmux-server-carries-the-macos-login-session.md)
already requires on macOS that the tmux server comes from the login session. If that server was
started from Terminal.app, its panes are likely billed to Terminal.app, and granting Terminal
microphone access once at the Mac would cover them. **That is inference. No Mac was tested.**

**Verdict: possible for one Mac the owner sets up by hand. Not something Yantra can install or
check reliably.** Linux first.

## 4. Plain ssh from the laptop, tonight

Two recipes. **A** needs nothing new on the laptop and almost nothing on the remote. **B** keeps the
laptop's audio server private but needs the §2 setup on the remote.

### A. Forward the laptop's Pulse socket (verified from this laptop to the Debian VM)

On the remote machine, once (Debian/Ubuntu names; Arch: `alsa-utils alsa-plugins`; Fedora:
`alsa-utils alsa-plugins-pulseaudio`):

```sh
sudo apt install alsa-utils libasound2-plugins
printf 'pcm.!default { type pulse }\nctl.!default { type pulse }\n' > ~/.asoundrc
```

On the laptop, each time (replace `1000` with the remote account's `id -u`):

```sh
ssh host 'rm -f /run/user/1000/laptop-pulse.sock'
ssh -o ExitOnForwardFailure=yes \
    -R /run/user/1000/laptop-pulse.sock:$XDG_RUNTIME_DIR/pulse/native host
```

In that remote shell:

```sh
export PULSE_SERVER=unix:/run/user/1000/laptop-pulse.sock
arecord -f S16_LE -r 16000 -c 1 -d 3 /tmp/t.wav   # speak; then copy it back and listen
claude                                           # then /voice
```

If `claude` runs in a tmux server that already exists, the pane does not have `PULSE_SERVER`. Run
`tmux set-environment -g PULSE_SERVER unix:/run/user/1000/laptop-pulse.sock`, open a new window, and
start `claude` there (`claude --continue` resumes the conversation). The laptop's microphone must be
unmuted — on this laptop it was muted, and was left that way.

What was verified: `pactl info` through the socket answered *"PulseAudio (on PipeWire 1.6.8)"* — the
laptop — with no cookie; `parec` and `arecord` (through `~/.asoundrc`) received 2–3 s of
16 kHz audio; the laptop listed the stream as `ALSA plug-in [aplay]` from host `yantra-qa`. The
remote socket was `srw-------`, owned by the remote account. A second `ssh -R` without the `rm`
failed with *"remote port forwarding failed for listen path"*. `StreamLocalBindUnlink yes` in the
remote's `sshd_config` removes the need for the `rm`, and needs root there.

**The cost:** while connected, the remote account can record the laptop microphone whenever it
likes, not only when you press the key. Use it only with machines you trust as much as the laptop.

### B. Stream PCM one way into the §2 virtual mic

With §2 done on the remote:

```sh
pw-record --raw --format s16 --rate 16000 --channels 1 - \
  | ssh host 'pw-cat --playback --raw --target yantra-mic-sink --format s16 --rate 16000 --channels 1 -'
```

The remote half was verified with a sine tone (§2). The laptop half ran and exited 0, but the
laptop's microphone is muted, so it carried silence; a spoken test is still owed. Nothing on the
remote can reach the laptop. The stream runs until Ctrl-C, so the microphone is open all that time.

## 5. The browser

- **Secure context.** `getUserMedia` exists only on HTTPS, `file:` or `localhost`
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)). The dashboard
  on `https://…:8443` through `tailscale serve` qualifies. `http://<tailnet-ip>:7717` does not: there
  `navigator.mediaDevices` is `undefined`.
- **Raw PCM through an AudioWorklet** is the path that needs nothing on the far side. The worklet
  receives Float32 frames at the context's rate (usually 48 kHz). It converts to s16 and downsamples
  to 16 kHz, or the page creates `new AudioContext({ sampleRate: 16000 })` and lets the browser
  resample. The far side is then `pw-cat --rate 16000`, which already exists there.
- **MediaRecorder** gives compressed chunks: WebM/Opus on Chrome and Firefox, and on Safari since
  18.4 ([WebKit, 2025-03-31](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)). But
  the remote then needs a decoder (`ffmpeg`, `opusdec` or GStreamer) that neither ADR-0028 nor §2
  installs, and MediaRecorder emits in `timeslice` chunks, which adds that much delay.
- **Bandwidth.** s16 mono is 16 kHz × 2 B = 32 kB/s = **256 kbit/s**; at 48 kHz, **768 kbit/s**.
  Opus speech is roughly 24–32 kbit/s. R16's mobile profile has 750 kbit/s up. So **16 kHz raw fits
  on a tailnet and on a phone; 48 kHz raw does not**. Opus is the answer only if a DERP-relayed phone
  proves too slow, and nobody has measured that.
- **Latency.** `pw-cat`'s default node latency is 100 ms (`--latency` changes it). Add the WebSocket
  and the ssh hop. Dictation tolerates a few hundred milliseconds; nothing here was measured end to
  end.
- **iOS.** A page loses the microphone when Safari goes to the background or the screen locks. The
  dashboard must show when the stream stops, and not pretend it is still live. (Known platform
  behaviour; not tested here.)

## 6. Recommended shape

1. On a Linux machine, the virtual mic is §2: a null sink plus a remap source, in a per-user
   `pipewire-pulse.conf.d` drop-in, set as the default source. PipeWire does the audio; Yantra only
   writes a config file and runs `pactl`.
2. The writer is one `ssh machine 'pw-cat --playback --raw --target yantra-mic-sink --format s16
   --rate 16000 --channels 1 -'`, with `XDG_RUNTIME_DIR` set by the command itself.
3. `yantrad` gets a microphone WebSocket beside the terminal one: binary frames are s16 16 kHz mono
   PCM, copied to that `ssh`'s stdin. It holds no buffer and logs no byte, as Q5 already requires of
   a terminal stream.
4. The dashboard captures with `getUserMedia` and an AudioWorklet, only on the HTTPS origin, and only
   while a button is held or toggled on.
5. `doctor` gains a check: `pactl` answers and `yantra-mic` exists as the default source.
6. Plain ssh uses §4 B with the same remote setup; §4 A stays a documented option with its warning.
7. macOS is out of scope for the first version.

## Open decisions for the ADR

1. **Who installs the audio packages?** [ADR-0028](../adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md) installs `tmux`, `git` and `claude` only, and defers
   optional tools to a checkbox. Is PipeWire an optional install, a documented manual step, or
   something `join.sh` offers?
2. **Who turns on linger?** It needs `sudo` once per machine. Without it the virtual mic exists only
   while someone is logged in.
3. **Does Yantra change the machine's default source (and, by side effect, default sink)?** Doing it
   is what makes "any program" and Claude Code hear it. It also displaces a desktop's real
   microphone, and routes the machine's own sounds into the mic.
4. **Raw 16 kHz PCM or Opus** on the browser leg. Raw needs nothing on the far side; Opus needs a
   decoder there.
5. **Is the microphone a write** under [ADR-0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)'s Tailscale-identity check? It sends a person's voice
   into a machine, so it likely is.
6. **Hold, toggle, or follow Claude Code's key?** Claude Code records only while its own key is held
   or toggled. The dashboard's microphone must be live at the same moment, and nothing links the two.
7. **Is §4 A (the forwarded Pulse socket) something Yantra ever sets up**, or only documents?
8. **macOS**: out of scope, or a manual BlackHole recipe in the docs?

## Sources

- Anthropic, *Voice dictation* — <https://code.claude.com/docs/en/voice-dictation> (accessed
  2026-09-29): requirements, the native module and its `arecord`/`rec` fallback, *"does not work in
  … SSH sessions"*, the troubleshooting messages.
- Claude Code 2.1.284 binaries, read with `strings` on 2026-09-29: Linux x64 at
  `~/.local/share/claude/versions/2.1.284`; macOS arm64 from
  `https://downloads.claude.ai/claude-code-releases/2.1.284/darwin-arm64/claude`. The recorder
  module's JavaScript is quoted in §1.
- anthropics/claude-code issue #79368 — <https://github.com/anthropics/claude-code/issues/79368>
  (accessed 2026-09-29): 2.1.215 on Arch; no documented way to force the fallback or to log the
  backend.
- J. A. Butt, *Claude Code Voice Over SSH* —
  <https://javedab.com/en/pub/ai/ai-editors/claude-code-voice-over-ssh/> (dated 2026-04-08, accessed
  2026-09-29): a TCP variant of §4 A with the same `~/.asoundrc`; it does not say it was tested.
- ExistentialAudio, *BlackHole* — <https://github.com/ExistentialAudio/BlackHole> (accessed
  2026-09-29): licence, HAL plug-in, `coreaudiod` restart.
- jenyalebid/jStack issue #239 — <https://github.com/jenyalebid/jStack/issues/239> (dated
  2026-09-28, accessed 2026-09-29): TCC bills processes spawned by `sshd` to `sshd-keygen-wrapper`.
- Apple Developer Forums thread 806187 — <https://developer.apple.com/forums/thread/806187>
  (accessed 2026-09-29): `sshd-keygen-wrapper` is a bundled executable that TCC treats as a client.
- tailscale/tailscale issue #5715 — <https://github.com/tailscale/tailscale/issues/5715> (accessed
  2026-09-29): `XDG_RUNTIME_DIR` unset under Tailscale SSH; closed 2023-02-18.
- MDN, *MediaDevices.getUserMedia()* —
  <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia> (accessed 2026-09-29):
  the secure-context requirement.
- WebKit, *WebKit Features in Safari 18.4* — <https://webkit.org/blog/16574/webkit-features-in-safari-18-4/>
  (accessed 2026-09-29): MediaRecorder WebM/Opus.
- `man ssh_config`, `man sshd_config` (OpenSSH 10.5p1, this laptop, 2026-09-29):
  `StreamLocalBindUnlink`.
- This laptop (CachyOS, PipeWire 1.6.8/1.6.9) and the Debian 13 QA VM (`~/vms/yantra-qa`, PipeWire
  1.4.2, WirePlumber 0.5.8, alsa-utils 1.2.14, libasound2-plugins 1.2.12), 2026-09-29: every command
  marked verified above.
