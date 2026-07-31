# 06 — Pi 5 feasibility: SSH transport, PTY, SQLite, hardware I/O

Research note for Yantra. Evidence retrieved **2026-07-28**. Day 0, no code exists.

> **Scope note, 2026-07-31.** This note was written to answer a language question that
> [ADR-0004](../adr/0004-rust-for-the-daemon.md) settled the same day. The language sections have been
> removed; what remains is the part that was never about a language — SSH multiplexing mechanics, the
> controlling-terminal requirement for a PTY, the SQLite-binding traps, and the Pi 5 hardware findings.
> Those produced **I-12, I-14, I-18, I-19 and I-20**, and they are why M8 is smaller than planned.
> Versions pinned at the time: OpenSSH 10.4p1, Raspberry Pi OS Bookworm/Trixie, kernel 6.12.x.

## Summary

- **SSH v1 = shell out to `ssh` with `ControlMaster`.** It inherits the user's real `~/.ssh/config` —
  jump hosts, `Match` blocks, agent forwarding, hardware keys, certificates — all of which any library
  reimplements and gets subtly wrong. **Windows OpenSSH does not support `ControlMaster`**
  (Win32-OpenSSH#1328, open since 2019).
- **A PTY must be created *with* its child, not before it.** A pre-constructed terminal that never gets
  `setsid()` + `TIOCSCTTY` is not the child's controlling terminal: **`^C` never delivers `SIGINT`** and
  `/dev/tty` resolves to the parent's.
- **SQLite's defaults are the trap, not SQLite.** `busy_timeout` defaults to **0** in bindings that do
  not set it, so a contended write throws `SQLITE_BUSY` immediately; and a synchronous binding on an
  async worker starves everything that worker serves.
- **The hardware layer needs no systems language at all — it needs the kernel.**
  `dtoverlay=rotary-encoder` makes the encoder an evdev device decoded in IRQ context;
  **`dtoverlay=ws2812-pio` makes the LED strip a `/dev/leds0` char device** driven by RP1's PIO. OLED
  and E-Ink are `/dev/i2c-1` and `/dev/spidev0.0`. Every legacy library — `pigpio`, `onoff`, `rpio`,
  `rpi_ws281x` — is dead on Pi 5.

## SSH transport

**How `ControlMaster`/`ControlPersist` actually works.** The first `ssh` with `ControlMaster=auto`
becomes the **master**: full TCP + KEX + auth, then it listens on a unix socket at `ControlPath`. Every
later `ssh`/`scp`/`sftp` using the same `ControlPath` opens a **new channel inside the existing
encrypted connection** — no TCP handshake, no key exchange, no re-auth. `ControlPersist=<time>`
backgrounds the master after its client exits and keeps it alive that long idle, so a burst of commands
pays the handshake once. `auto` is opportunistic: if the socket is missing or dead, this `ssh` connects
normally and becomes the new master, so stale sockets break nothing.

```sh
mkdir -p ~/.config/yantra/cm && chmod 700 ~/.config/yantra/cm

ssh -o ControlMaster=auto -o ControlPath=~/.config/yantra/cm/%C \
    -o ControlPersist=10m -o BatchMode=yes -o ConnectTimeout=5 \
    host -- tmux ls
```

- `%C` hashes (local host, remote host, port, user) — short and unique. This matters: `ControlPath` is
  an `AF_UNIX` path capped near 104 bytes. Never build it from `%h_%p_%r` under a deep directory. The
  directory must be 0700; it holds a live authenticated connection.
- Daemon control commands: `ssh -O check|exit|stop host`, plus `ssh -O forward|cancel`. `BatchMode=yes`
  is mandatory: fail fast instead of hanging on a password prompt.
- **Windows, verified negative.** `Control*` are **not supported by native Windows OpenSSH**;
  Win32-OpenSSH#1328 has been open since **2019-01-23** (the client cannot create the AF_UNIX socket).
  Multiplexing is client-side, so reaching *out to* a Windows host from the Pi is unaffected.

### Verdict for v1

**Shell out to the system `ssh` with `ControlMaster`** — I-20, and §B2 of `CLAUDE.md`. The alternative
is a library that reimplements `~/.ssh/config` and gets the edge cases wrong; the record of one such
library shows five distinct bugs found only by its own users in production, against an upstream that
supports exactly one runtime. Keep an in-process library in reserve only for many concurrent
long-lived channels with fine-grained flow control, which Yantra does not have.

The follow-on note [07](07-ssh-transport.md) works out what this costs: `ssh` reports a signal-killed
remote command as exit 255 with empty stderr, so signal death, a remote 255 and a dropped multiplexed
connection are indistinguishable without a sentinel.

## PTY

**Create the PTY as part of spawning the child.** The failure mode found here is worth stating as a
rule because it is easy to ship unnoticed: when a terminal object is constructed first and handed to a
spawn call afterwards, the implementation may never perform `setsid()` + `TIOCSCTTY`, so the PTY is not
the child's **controlling terminal**. Everything looks fine — the process starts, `write()` works, exit
fires — but **`^C` never delivers `SIGINT`**, and `/dev/tty` inside the child resolves to the parent's.

That is **I-18**, and it is language-independent. Verify it explicitly in the `portable-pty`
integration test rather than assuming the crate does it.

Second-order defects seen in the same subsystem, worth checking against whatever is used: no drain
signal on POSIX, so there is no backpressure; output truncated at child exit unless the session sends
an explicit end-of-session marker; and `TERM` not propagated from the terminal's own name.

## Persistence

**SQLite is right; the binding's defaults are not.** Set these explicitly on every connection open —
this is **I-12**:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;   -- NOT optional
PRAGMA foreign_keys = ON;
```

- **`busy_timeout` defaults to 0** in bindings that do not set it, so a contended write throws
  `SQLITE_BUSY` immediately. Verified against two independent bindings; neither exposed it as a
  constructor option. Five machines heartbeating every 10 s will otherwise produce intermittent
  failures that present as a network or agent fault.
- **A synchronous binding on an async worker starves it.** Measured elsewhere: one 400 ms query while
  100 requests arrived served **0 of 100**, p50 420 ms. In Rust the fix exists — `spawn_blocking`,
  which is **I-13** — but the trap is the same, so keep queries O(small) regardless.
- **WAL gives concurrent readers with one writer, not concurrent writers.** So: **the daemon owns the
  database; the CLI talks to the daemon and never opens the file.**
- Prefer a cached prepared statement for fixed SQL and an explicit prepare for **dynamically generated**
  SQL. Filling a statement cache with varying query text is unbounded memory growth, which is exactly
  what a long-lived daemon does if you get this backwards.
- No `backup()` in every binding — `VACUUM INTO` is the portable answer. SD cards, not SQLite, are the
  durability risk: put the database on NVMe.
- **ORM: not yet.** Yantra's schema is four small tables. Raw SQL plus a hand-written
  `migrations/NNN.sql` runner, per §A2. That is **I-14**.

## Pi 5 hardware I/O

**The premise is correct and stronger than stated — but the conclusion everyone draws is wrong.** Pi 5
moves user GPIO to the RP1 southbridge behind PCIe; no offset patch saves the old libraries, because
RP1 uses IO_BANK/RIO/PADS, not BCM283x GPFSEL/GPSET/GPCLR. Plain `/dev/gpiomem` is gone;
`bcm2712-rpi.dtsi` defines **`/dev/gpiomem0` … `gpiomem4`**, and **`gpiomem0` is the 40-pin header**
(the widely repeated "use gpiomem4" is wrong — that is BCM2712 always-on pinctrl).

**Do not use on Pi 5, all confirmed broken and unfixed:** `pigpio`/`pigpiod` (joan2937/pigpio#589, open
since 2023-11), `onoff`, `rpi-gpio`, `rpio`, `rpi-ws281x`, `raspi-rotary-encoder`. `onoff` is doubly
dead: the sysfs GPIO base offset is unstable *and* **Raspberry Pi OS Trixie ships without
`CONFIG_GPIO_SYSFS`** (fivdi/onoff#206).

**gpiochip numbering — the trap.** raspberrypi/linux PR #6144 (merged 2024-08-05, kernel ≥ 6.6.47) made
the header **`gpiochip0`** and moved the SoC chips to **`gpiochip10`–`13`**. Every tutorial written
between Oct 2023 and Aug 2024 says `gpiochip4`; false for two years. **Resolve at runtime by the label
`pinctrl-rp1`** (`gpiodetect`, `gpiofind`) — never ship a literal index. That is **I-19**. libgpiod is
v1.6.3 on Bookworm, **v2.2.1 on Trixie**, with different `gpioset` syntax.

**I²C and SPI are untouched** — they are char devices (`dtparam=i2c_arm=on`, `dtparam=spi=on`). Header
I²C is still **`/dev/i2c-1`**, SPI still `/dev/spidev0.0`.

| Peripheral | Reachable from userspace? | How |
| --- | --- | --- |
| Rotary encoder | **Yes — best case in the note** | `dtoverlay=rotary-encoder,pin_a=…,pin_b=…,relative_axis=1` + `dtoverlay=gpio-key` for the push switch. The **kernel** does Gray-code quadrature decoding in the IRQ handler and exposes an evdev node; userspace reads 24-byte `input_event` records (`type` @16, `code` @18, `value` @20, LE) off `/dev/input/eventN`. **Zero dependencies, zero device-specific code.** A scheduling delay makes the count *late*, never *wrong*. Demonstrated on Pi 5 / kernel 6.12.x by a Raspberry Pi engineer. |
| WS2812 / NeoPixel | **Yes — this overturns the standard assumption** | `dtoverlay=ws2812-pio,gpio=N,num_leds=M` (**Pi 5 only**, in-tree driver `ws2812-pio-rp1.c`) exposes **`/dev/leds0`**. RP1's PIO generates the 800 kHz signal. One write of 4 bytes/pixel, LE `0xWWBBGGRR`, is one frame; a 1-byte write at offset 0 sets brightness; gamma applied in-kernel. Userspace has **no timing responsibility**. The node is `root:root 0600` — add a udev rule. |
| SSD1306 / SH1106 OLED, I²C | **Yes** | Open `/dev/i2c-1` and push the framebuffer. 128×64 mono ≈ 9.2 kbit/frame → ~10 fps at 100 kHz, **20–30 fps at 400 kHz–1 MHz**; page/column addressing (`0x21`/`0x22`) for partial updates. ~150 lines against the char device beats every stale wrapper package. |
| E-Ink over SPI | **Yes, trivially** | `/dev/spidev0.0` + 4 GPIO lines (RST/DC/BUSY/CS). Panel refresh is 2–5 s full, 0.3–1 s partial. Watch raspberrypi/linux#6020 (open): Pi 5 SPI DMA timeouts on large transfers, workaround `dtparam=nospidma`. |

**Permissions:** the daemon user needs `gpio`, `i2c`, `spi` and **`input`**; restart the session after
`usermod`. `/dev/leds0` has no shipped rule: add `KERNEL=="leds[0-9]*", GROUP="gpio", MODE="0660"`.

### Verdict: the hardware layer is file descriptors

**On Pi 5 the kernel and RP1's PIO already provide the real-time layer.** The `rotary-encoder` overlay
turns the peripheral everyone assumes needs interrupt handling into a `read()`; `ws2812-pio` turns the
one everyone assumes needs bit-banging into a `write()`. Both are in-tree drivers, shipped as the
replacement for pigpio's DMA tricks. **General rule: when a peripheral looks like it needs precise
timing, look for a device-tree overlay before reaching for a language** (`rotary-encoder`,
`ws2812-pio`, `gpio-key`, `pwm`, `gpio-ir`, `w1-gpio`). Only if none fits does PIOLib (~10 µs/op) or a
microcontroller arise.

**Keep the hardware layer a separate process — for lifecycle reasons, not timing.** The panel should
keep showing something while the daemon restarts; device permissions stay confined to one small
process; the redraw loop stays off the thread pool where blocking SQLite lives. A second process
speaking JSON lines over `$XDG_RUNTIME_DIR/yantra/panel.sock` also keeps the seam cheap: it is one
binary swap behind a socket.

**Microcontroller vs GPIO from the Pi: do it on the Pi.** RP2040-over-USB-serial (`HyperSerialPico` is
proven prior art) was the *correct* answer for a Pi 4, where WS2812 forced DMA/PWM register poking. On
a Pi 5 it buys nothing `dtoverlay=ws2812-pio` does not already give, and adds firmware, a serial
protocol and a flashing story. **Reconsider only** for hard-realtime closed loops, or if 5 V level
shifting makes a Pico worth it anyway — an electrical argument.

## Risks & unknowns

- **Nothing here ran on a Pi 5.** No hardware claim was executed. The overlays are documented and
  backed by in-tree drivers, and the encoder one was demonstrated by an RPi engineer, but **nobody has
  checked `/dev/leds0` byte order against a real strip.** `ws2812-pio` is also "Pi 5 only, up to 4,
  assuming nothing else uses PIO".
- **The SQLite numbers were measured on other bindings**, not on `rusqlite`. The trap belongs to
  SQLite's C API, so it is *expected* to carry over — expected is not measured.
- **`ControlMaster` failure modes are untested**: network drop mid-command, stale socket, whether
  masters survive a daemon restart. Integration-test against a real sshd per §B3.

## Sources

*All retrieved 2026-07-28.*

- SSH & PTY: local `ssh_config(5)` from OpenSSH_10.4p1 ·
  [Win32-OpenSSH#1328](https://github.com/PowerShell/Win32-OpenSSH/issues/1328) (open since 2019-01-23) ·
  [mscdex/ssh2#1416](https://github.com/mscdex/ssh2/issues/1416) ·
  [node-pty#860](https://github.com/microsoft/node-pty/issues/860)
- Pi 5 primary:
  [`bcm2712-rpi.dtsi`](https://github.com/raspberrypi/linux/blob/rpi-6.12.y/arch/arm64/boot/dts/broadcom/bcm2712-rpi.dtsi) ·
  [PR #6144 gpiochip0](https://github.com/raspberrypi/linux/pull/6144) ·
  [overlays README (`rotary-encoder` L4393, `ws2812-pio` L6157)](https://github.com/raspberrypi/linux/blob/rpi-6.12.y/arch/arm/boot/dts/overlays/README) ·
  [`ws2812-pio-rp1.c`](https://github.com/raspberrypi/linux/commit/d6d83ad3d9a3a594909a1ad1c82b735ab711cd12) ·
  [linux#6020 SPI DMA](https://github.com/raspberrypi/linux/issues/6020) ·
  [99-com.rules udev](https://github.com/RPi-Distro/raspberrypi-sys-mods/blob/master/etc.armhf/udev/rules.d/99-com.rules) ·
  [PIOLib](https://www.raspberrypi.com/news/piolib-a-userspace-library-for-pio-control/) ·
  [forums: rotary-encoder on Pi 5](https://forums.raspberrypi.com/viewtopic.php?p=2334541)
- Pi 5 libraries, all confirmed dead: [pigpio#589](https://github.com/joan2937/pigpio/issues/589) ·
  [onoff#206](https://github.com/fivdi/onoff/issues/206) ·
  [rpi_ws281x#528](https://github.com/jgarff/rpi_ws281x/issues/528) ·
  [node-libgpiod#44](https://github.com/sombriks/node-libgpiod/issues/44) ·
  [HyperSerialPico](https://github.com/awawa-dev/HyperSerialPico)
- SQLite: `sqlite.org/pragma.html`, `sqlite.org/wal.html`, `sqlite.org/lang_vacuum.html#vacuuminto`
- "Verified locally" ran here 2026-07-28: x86_64 CachyOS, kernel 7.1.3-2, OpenSSH_10.4p1.
