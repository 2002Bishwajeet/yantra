# 06 — Runtime feasibility: Bun on arm64 / Pi 5, SSH, PTY, hardware I/O

> ### ⚠️ Superseded runtime decision
> This note was written while the target runtime was **TypeScript on Bun**. That decision was
> superseded the same day by [ADR-0004](../adr/0004-rust-for-the-daemon.md) — the daemon is **Rust**.
> Kept unedited as dated evidence. Its findings about tmux, Tailscale, agent CLIs, prior art and
> scheduling remain valid; its **runtime recommendations do not**. Note that Bun was *not*
> disqualified — the verdict was GO-WITH-CAVEATS; the decision criteria changed, not the evidence.

Research note for YANTRA. Evidence retrieved **2026-07-28**. Day 0, no code exists. Blocks ADR-0003 triggers T1–T5 and ADR-0004
(transport).

Versions pinned: **Bun 1.3.14** (2026-05-13, latest stable), Node 24 LTS (current line v26.5.0), OpenSSH 10.4p1, Raspberry Pi OS
Bookworm/Trixie, kernel 6.12.x.

## Summary

- **GO-WITH-CAVEATS on Bun for the Pi 5, and the caveats are bigger than the arm64 question.** arm64 is a shipped target; the
  aarch64 binary uses 64 KB segment alignment so it *loads* on 4 K/16 K/64 K page kernels; and Bun uses **mimalloc, not jemalloc**,
  so the `Unsupported system page size` abort that kills Typesense/InfluxDB/EasyTier on Pi 5 does not apply. But bun#17627 is
  **still open with "manually check it works on 16k" unticked and no CI on any non-4K page size**. T1 is *untested*, not disproved.
- **The bigger risk is project state.** Bun stable has been **frozen since 2026-05-13** while a **~1M-line rewrite of Bun in Rust**
  (bun#30412) lands for an unshipped v1.4.0 that is **explicitly a breaking release** (bun#28792), with no public statement on
  N-API compatibility under it. Most fixes cited below are on unreleased `main`. **Pin the version; treat 1.4.0 as re-qualification.**
- **PTY: use `Bun.Terminal` via the inline `Bun.spawn({ terminal })` form — never `new Bun.Terminal()`, never node-pty.** node-pty
  under Bun is broken on Linux today (bun#25822: `onData` never fires; open, fix unmerged since April), and `node-pty@1.1.0` ships
  **no Linux prebuilds at all**.
- **SSH v1 = shell out to `ssh` with ControlMaster.** Zero Bun surface; inherits the user's real `~/.ssh/config`. `ssh2` works, but
  only after Bun fixed five node-compat bugs that *only ssh2 users found*. **Windows OpenSSH does not support ControlMaster**
  (Win32-OpenSSH#1328, open since 2019).
- **The hardware layer needs no Rust at all — it needs the kernel.** `dtoverlay=rotary-encoder` makes the encoder an evdev device
  decoded in IRQ context; **`dtoverlay=ws2812-pio` makes the LED strip a `/dev/leds0` char device** driven by RP1's PIO. OLED and
  E-Ink are `/dev/i2c-1` and `/dev/spidev0.0`. **T4 does not fire.** Every legacy library — `pigpio`, `onoff`, `rpio`,
  `rpi_ws281x` — is dead on Pi 5.
## Bun on arm64 / Pi 5

`bun-linux-aarch64` (glibc ≥ 2.17) and `-musl` are shipped artefacts; arm64 has **no baseline/modern split**. Pi 5 (Cortex-A76,
ARMv8.2-A) is newer than the ARMv8.0 parts behind the 2024 "Illegal instruction" crashes on Pi 4 (bun#12076/#12173, fixed by
#12504). Read that honestly: **arm64 Linux is a real target that breaks periodically and is fixed a release or two later.**

### The page-size question

Pi 5 firmware loads `kernel_2712.img` → **16 KB pages** (`getconf PAGESIZE` = `16384`). `kernel=kernel8.img` in
`/boot/firmware/config.txt` reverts to 4 KB at ~7% on random-memory access. **Run `getconf PAGESIZE` on the target before anything
else in this note matters.**

Positive evidence, strongest first: (1) **verified locally** — `readelf -lW` on the official `bun-linux-aarch64` v1.3.14 binary
shows every `LOAD` segment at `Align 0x10000` (64 KB), ruling out the "segments not page aligned" failure class; (2) **verified
locally** — `strings` shows `mimalloc`, no `jemalloc`; (3) JSC runs at 16 KB daily, since that is Apple Silicon macOS's page size —
the risk is Bun's Zig/Linux glue, not JavaScriptCore; (4) bun#17820 upgraded Zig so page size is read at runtime; (5) **64 KB
support shipped in v1.3.12** via a JSC patch (oven-sh/WebKit#176), closing bun#6241.

Negatives, loudly: **bun#17627 is OPEN**, last touched 2026-04-10, with the 16 K check and both CI items **unticked** — no public
confirmation of a 16 KB run exists, and **no CI covers any non-4K page size**. On that same issue: on **64 KB** pages v1.3.12 fixed
the REPL but binaries from **`bun build --compile` still die with `Trace/breakpoint trap (core dumped)`** — "the runtime works" and
"the compiled binary works" are separate claims, and `--compile` is Yantra's shipping mode. And **no credible first-hand report of
Bun on a Pi 5 exists**; the SEO "Pi 5 compatibility guides" cite nothing.

**Release freeze.** `bun@latest` = 1.3.14, **2026-05-13**, against a prior 2026 cadence of 10–21 days; npm `canary` is stale at
`1.3.13-canary.20260425.1`. Nearly every fix referenced below is on unreleased `main`, including ~25 N-API correctness PRs in July
2026 and the entire `node:sqlite` implementation. **Do not trust "closed" on Bun's tracker right now** — the `robobun` bot closed
1,148 issues in the eight days to 2026-07-28, admitting fixes "landed after 1.3.14 and are not in a stable release yet."

**Measured footprint.** Measured here 2026-07-28: x86_64, CachyOS kernel 7.1.3, 4 KB pages, Bun 1.3.14 vs Node v24.0.0. **Not a Pi** — a floor, not a prediction.

| | Bun 1.3.14 | Node 24.0.0 |
| --- | --- | --- |
| Cold start `-e '0'`, min / median of 10 | **10.6 / 11.1 ms** | 17.5 / 18.2 ms |
| Peak RSS of that process | 31 MB | 51 MB |
| Idle HTTP server RSS, 3 s after listen | **36.7 MB** (`Bun.serve`) | 62.0 MB (`http.createServer`) |

A Pi 5 is ~3–5× slower single-thread: expect **~35–55 ms cold start** and a **50–90 MB** idle daemon; 16 KB pages round every
mapping up, so budget 20–40% RSS inflation. **T2 (250 MB) and T3 (300 ms) have large headroom.** Watch instead the *2% idle CPU*
clause, open long-running-process leak reports (bun#29267, #25550, #24858), and bun#28911 (unbounded RSS from dynamic SQL, OOM'd a 1
GB container).

### Node 24 LTS as fallback

Viable. Type stripping is **`Stability: 2 - Stable`** (v24.12.0 / v25.2.0) but does **no type checking**, ignores `tsconfig.json`,
and rejects enums, parameter properties, namespaces and decorators — set **`erasableSyntaxOnly: true`** from day one regardless of
runtime, a zero-cost portability guard rail. `node:test` is stable; `node:sqlite` is **not** (`Stability: 1.x`) and is synchronous,
exactly like `bun:sqlite`. Lost by switching: `Bun.serve`'s WebSocket *server* (→ `ws`), `Bun.$` (→ `execa`), `Bun.build` (→
`esbuild`), state-preserving `--hot`, `bun:ffi` (→ `koffi`), `Bun.Terminal` (node-pty works *fine* on Node — a Node win), and **`bun
build --compile`**: Node's SEA is CJS-only with a postject step on the 24 line, ~110–140 MB, and **cannot cross-compile at all**.

## SSH approach comparison

| | `ssh2` (pure JS) | shell out to `ssh` + ControlMaster | Rust helper (`russh`) |
| --- | --- | --- | --- |
| Works under Bun today | Yes, after 5 Bun fixes | Yes — no Bun surface at all | Via N-API (`russh` 0.1.37) or subprocess |
| Bun compat risk | **High** — hammers node:crypto/net/stream | **None** | N-API risk, or none as subprocess |
| Honours `~/.ssh/config`, `Match`, jump hosts, agent, FIDO keys, certs | partially, reimplemented | **Yes, exactly, free** | No, reimplemented |
| Latency after warm-up | ~0 (in-process) | **~10–40 ms** on a live master | ~0 |
| Streaming / PTY | `stream.pty` | `ssh -tt` + `Bun.Terminal` | native |
| Windows control-plane host | works | **ControlMaster unsupported**, 1 proc/cmd | works |
| Cost to Yantra | new dep + canary duty | **zero new deps** | new toolchain |

**How ControlMaster/ControlPersist actually works.** The first `ssh` with `ControlMaster=auto` becomes the **master**: full TCP + KEX + auth, then it listens on a unix socket at
`ControlPath`. Every later `ssh`/`scp`/`sftp` using the same `ControlPath` opens a **new channel inside the existing encrypted
connection** — no TCP handshake, no key exchange, no re-auth. `ControlPersist=<time>` backgrounds the master after its client exits
and keeps it alive that long idle, so a burst of commands pays the handshake once. `auto` is opportunistic: if the socket is missing
or dead, this `ssh` connects normally and becomes the new master, so stale sockets break nothing.

```sh
mkdir -p ~/.config/yantra/cm && chmod 700 ~/.config/yantra/cm

ssh -o ControlMaster=auto -o ControlPath=~/.config/yantra/cm/%C \
    -o ControlPersist=10m -o BatchMode=yes -o ConnectTimeout=5 \
    host -- tmux ls
```

- `%C` hashes (local host, remote host, port, user) — short and unique. This matters: `ControlPath` is an `AF_UNIX` path capped near
  104 bytes. Never build it from `%h_%p_%r` under a deep directory. The directory must be 0700; it holds a live authenticated
  connection.
- Daemon control commands: `ssh -O check|exit|stop host`, plus `ssh -O forward|cancel`. `BatchMode=yes` is mandatory: fail fast
  instead of hanging on a password prompt.
- **Windows, verified negative.** `Control*` are **not supported by native Windows OpenSSH**; Win32-OpenSSH#1328 has been open since
  **2019-01-23** (the client cannot create the AF_UNIX socket). Multiplexing is client-side, so reaching *out to* a Windows host
  from the Pi is unaffected.

### Verdict for v1

**Shell out to the system `ssh` with ControlMaster.** It reuses the user's real SSH config — jump hosts, `Match` blocks, agent
forwarding, hardware keys, certificates — all of which `ssh2` would reimplement and get subtly wrong, with zero Bun compatibility
surface. Matches §B2. Keep `ssh2` in reserve only for many concurrent long-lived in-process channels with fine-grained flow control.
The ssh2-under-Bun record — mscdex/ssh2#1416 (2024-08: a production SSH server broke on `Buffer.prototype.utf8Write`, fixed in Bun
1.1.27), then bun#4487, #10425, #7130, #21807 (Bun's WebSocket fragmented a ~564-byte SSH KEX reply), #26418. All fixed — every one
found by an ssh2 user in production. Upstream: *"This project only supports node.js."*

## PTY & native modules

**Use `Bun.Terminal`, inline form.** Shipped in Bun 1.3.5 (2025-12-17, PR #25415):

```ts
const proc = Bun.spawn(["ssh", "-tt", "host"], {
  terminal: { cols: 80, rows: 24, data(term, chunk) { ws.send(chunk); } },
});
proc.terminal.write("…"); proc.terminal.resize(120, 40);
```

**Critical: do not construct `new Bun.Terminal()` and pass it to `Bun.spawn`.** bun#33237 (open) — a pre-created terminal never gets
`setsid()` + `TIOCSCTTY`, so the PTY is not the child's controlling terminal: **`^C` never delivers SIGINT** and `/dev/tty` resolves
to the parent's. The inline form *does* make the child a session leader on 1.3.14 (maintainer-verified); fix PR #33240 is unmerged.

Other 1.3.14 defects, fixed only on unreleased `main`: `drain` **does not fire on POSIX** (#34289) so there is no backpressure
signal; output can be **truncated at child exit** (#34225) — send an explicit end-of-session marker; **`TERM` is not set from
`terminal.name`** (#34290, open). When `terminal` is set, `proc.stdin/stdout/stderr` are `null`. POSIX only. ~20 PRs touched this
subsystem in July 2026 and none shipped — **pin Bun, re-test on 1.4.0.**

**Do not use node-pty under Bun.** bun#25822 (open since 2026-01-04, reproduced on **Bun 1.3.14, Linux x86_64**, with Node 24 as a
working control): the PTY spawns, `write()` works, `onExit` fires — **no output ever arrives**. bun#29112 diagnoses the related
`ioctl(2) failed, EBADF`: node-pty wraps the `O_NONBLOCK` master fd in `tty.ReadStream`, which Bun backs with `fs.ReadStream`, whose
threadpool read surfaces EAGAIN, destroys the stream and **closes a caller-owned fd**; fix PR #29114 unmerged since April. Also
**`node-pty@1.1.0` ships no Linux prebuilds** — only `1.2.0-beta` has arm64.

**Fallback: `bun-pty@0.4.10`** (2026-06-15) — Rust `portable-pty` over `bun:ffi`, *not* N-API, prebuilt `librust_pty_arm64.so` plus
musl, works under `--compile`. Not a drop-in; single maintainer; young.

**Native modules generally — prefer zero.** Bun implements N-API but **not** the V8 C++ API, so `nan` addons are a coin flip
(bun#4290, open since 2023); libuv is barely implemented (bun#18546), the root cause of "addon loads but callbacks never fire"; and
in 1.3.14 `napi_get_version()` **returns 9 while `process.versions.napi` says 10**, so spec-following addons take degraded paths.
Bun also **hard-blocks `better_sqlite3.node` at `process.dlopen` by filename**. Finally: Bun runs no lifecycle scripts by default
but ships a **367-entry default allow-list**, and **your `trustedDependencies` array replaces that list rather than extending it** —
adding one package silently disables all 367, failing as a missing `.node` and a confusing runtime error.

## Persistence

**Correction to a tempting assumption: `node:sqlite` is NOT in any released Bun.** bun#29821 was **closed unmerged**; the
implementation landed via bun#32498 on `main` on **2026-07-17, two months after 1.3.14**. Verified: on 1.3.14
**Correction to a tempting assumption: `node:sqlite` is NOT in any released Bun.** bun#29821 was **closed unmerged**; the work
landed via bun#32498 on `main` on **2026-07-17, two months after 1.3.14** — on 1.3.14, `require('node:sqlite')` throws
`ERR_UNKNOWN_BUILTIN_MODULE`. The "write once, run on both runtimes" hedge is not available today. Use **`bun:sqlite` behind a
~40-line adapter** (per §B2) that a `node:sqlite` implementation can replace later; the APIs are close but incompatible
(`Database` vs `DatabaseSync`, `.get()` → `null` vs `undefined`, `safeIntegers` vs `readBigInts`, `db.transaction()` vs none, and
only `node:sqlite` has UDFs, aggregates and `backup()`).
connection with:

```ts
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 5000");   // NOT optional — Bun's default is 0
db.exec("PRAGMA foreign_keys = ON");
```

- **`busy_timeout` defaults to 0** with no constructor option (bun#5621, wontfix), so a contended write throws `SQLITE_BUSY`
  immediately. better-sqlite3 defaults to 5000.
- **Every query blocks the event loop.** Measured in bun#34863: one 400 ms query while 100 requests arrive → **0/100 served**, p50
  420 ms. Async has been open since 2022 (bun#978) and `sqlite3_interrupt` is not exposed (bun#31014) — a runaway query can only be
  killed with the process.
- **WAL gives concurrent readers with one writer, not concurrent writers.** So: **the daemon owns the database; the CLI talks to the
  daemon and never opens the file.** bun#34446 (open): concurrent `new Database(path)` across Workers intermittently sees an empty
  schema.
- Use `db.query()` (statement cache) for fixed SQL, `db.prepare()` for **dynamically-generated** SQL — bun#28911 is unbounded RSS
  from filling the cache with varying query text, exactly what a long-lived daemon does if you get this backwards.
- No `backup()` (use `.serialize()` or `VACUUM INTO`), no UDFs. Integers past 2^53 truncate unless `safeIntegers: true`. SD cards,
  not SQLite, are the durability risk — put the DB on NVMe.

**ORM: not yet.** `drizzle-orm/bun-sqlite` is a first-class runtime driver, but the stable line has not moved since March (docs
point at `@rc`), drizzle-kit has no `driver: 'bun:sqlite'` (#1520 open since 2023) and `pull`/`studio` are broken on `latest`.
Kysely has **no first-party dialect**. Per §A2: **raw SQL plus a hand-written `migrations/NNN.sql` runner.**

## Pi 5 hardware I/O

**The premise is correct and stronger than stated — but the conclusion everyone draws is wrong.** Pi 5 moves user GPIO to the RP1
southbridge behind PCIe; no offset patch saves the old libraries, because RP1 uses IO_BANK/RIO/PADS, not BCM283x GPFSEL/GPSET/GPCLR.
Plain `/dev/gpiomem` is gone; `bcm2712-rpi.dtsi` defines **`/dev/gpiomem0` … `gpiomem4`**, and **`gpiomem0` is the 40-pin header**
(the widely repeated "use gpiomem4" is wrong — that is BCM2712 always-on pinctrl).

**Do not use on Pi 5, all confirmed broken and unfixed:** `pigpio`/`pigpiod` (joan2937/pigpio#589, open since 2023-11), `onoff`,
`rpi-gpio`, `rpio`, `rpi-ws281x`, `raspi-rotary-encoder`. `onoff` is doubly dead: the sysfs GPIO base offset is unstable *and*
**Raspberry Pi OS Trixie ships without `CONFIG_GPIO_SYSFS`** (fivdi/onoff#206).

**gpiochip numbering — the trap.** raspberrypi/linux PR #6144 (merged 2024-08-05, kernel ≥ 6.6.47) made the header **`gpiochip0`**
and moved the SoC chips to **`gpiochip10`–`13`**. Every tutorial written between Oct 2023 and Aug 2024 says `gpiochip4`; false for
two years. **Resolve at runtime by the label `pinctrl-rp1`** (`gpiodetect`, `gpiofind`) — never ship a literal index. libgpiod is
v1.6.3 on Bookworm, **v2.2.1 on Trixie**, with different `gpioset` syntax.

**I²C and SPI are untouched** — char devices, so `i2c-bus` and `spi-device` remain correct (`dtparam=i2c_arm=on`, `dtparam=spi=on`).
Header I²C is still **`/dev/i2c-1`**, SPI still `/dev/spidev0.0`. `i2c-bus` builds and runs on Node 24 on a Pi 5 provided the
lockfile resolves **`nan` ≥ 2.20** (fivdi/i2c-bus#130 was a stale `nan@2.18.0` pin, not a Pi 5 bug).

| Peripheral | From JS on Pi 5? | How |
| --- | --- | --- |
| Rotary encoder | **Yes — best case in the note** | `dtoverlay=rotary-encoder,pin_a=…,pin_b=…,relative_axis=1` + `dtoverlay=gpio-key` for the push switch. The **kernel** does Gray-code quadrature decoding in the IRQ handler and exposes an evdev node; JS reads 24-byte `input_event` records (`type` @16, `code` @18, `value` @20, LE) off `/dev/input/eventN`. **Zero dependencies, zero native code.** A GC pause makes the count *late*, never *wrong*. Demonstrated on Pi 5 / kernel 6.12.x by a Raspberry Pi engineer. |
| WS2812 / NeoPixel | **Yes — this overturns the standard assumption** | `dtoverlay=ws2812-pio,gpio=N,num_leds=M` (**Pi 5 only**, in-tree driver `ws2812-pio-rp1.c`) exposes **`/dev/leds0`**. RP1's PIO generates the 800 kHz signal. One `fs.writeSync` of 4 bytes/pixel, LE `0xWWBBGGRR`, is one frame; a 1-byte write at offset 0 sets brightness; gamma applied in-kernel. Userspace has **no timing responsibility**. Node is `root:root 0600` — add a udev rule. |
| SSD1306 / SH1106 OLED, I²C | **Yes** | `i2c-bus`, push the framebuffer. 128×64 mono ≈ 9.2 kbit/frame → ~10 fps at 100 kHz, **20–30 fps at 400 kHz–1 MHz**; page/column addressing (`0x21`/`0x22`) for partial updates. Every dedicated npm OLED package is 5+ years stale — write ~150 lines over `i2c-bus`. |
| E-Ink over SPI | **Yes, trivially** | `spi-device` + 4 GPIO lines (RST/DC/BUSY/CS). Panel refresh is 2–5 s full, 0.3–1 s partial. `waveshare-epaper` 0.2.4 works but **its "Pi 5 → gpiochip4" README instruction is stale and will break it**, and it shells out to `gpioset` per pin change. Watch raspberrypi/linux#6020 (open): Pi 5 SPI DMA timeouts on large transfers, workaround `dtparam=nospidma`. |

**If plain GPIO line control is ever needed:** `node-libgpiod` (0.6.0) looks maintained but is **libgpiod v1 only** and uses `nan`
— it will not compile on Trixie (issue #44), and Bun cannot load `nan` addons anyway. Prefer **`rpi-io`** (3.1.3, 2026-07-27;
N-API, detects libgpiod v1 *or* v2, tested on Pi 5 × Bookworm/Trixie) or **`@iiot2k/gpiox`** (prebuilt N-API arm64 over raw uAPI v2
ioctls), or shell out to `gpioset`/`gpiomon`. **Permissions:** the daemon user needs `gpio`, `i2c`, `spi` and **`input`**; restart
the session after `usermod`. `/dev/leds0` has no shipped rule: add `KERNEL=="leds[0-9]*", GROUP="gpio", MODE="0660"`.

## Recommended TypeScript-vs-Rust boundary

**Everything stays TypeScript on Bun.** The daemon (HTTP/WS API, state machine, scheduling, telemetry, SQLite); **all SSH**
(subprocess `ssh` + ControlMaster); **all PTY and terminal streaming** (`Bun.Terminal` inline + `ssh -tt` + remote `tmux`); the CLI;
and — the surprise — **the entire hardware layer**, which is all file descriptors: `/dev/i2c-1`, `/dev/spidev0.0`,
`/dev/input/eventN`, `/dev/leds0`. None is a timing problem in userspace.

**No Rust is required anywhere, and T4 does not fire.** ADR-0003 assumed the opposite, so say it plainly: **on Pi 5 the kernel and
RP1's PIO already provide the real-time layer.** The `rotary-encoder` overlay turns the peripheral everyone assumes needs interrupt
handling into a `read()`; `ws2812-pio` turns the one everyone assumes needs bit-banging into a `write()`. Both are in-tree drivers,
shipped as the replacement for pigpio's DMA tricks. **General rule: when a peripheral looks like it needs precise timing, look for
a device-tree overlay before reaching for a language** (`rotary-encoder`, `ws2812-pio`, `gpio-key`, `pwm`, `gpio-ir`, `w1-gpio`).
Only if none fits does PIOLib + an N-API wrapper (~10 µs/op) or a microcontroller arise.

**Keep the hardware layer a separate process — for lifecycle reasons, not timing.** The panel should keep showing something while
the daemon restarts; device permissions stay confined to one small process; the redraw loop stays off the event loop where blocking
synchronous SQLite lives. Make it a **second Bun process** speaking JSON lines over `$XDG_RUNTIME_DIR/yantra/panel.sock` — which
also preserves the escape hatch for free: if it ever must be Rust, it is one binary swap behind a socket.

**Microcontroller vs GPIO from the Pi: do it on the Pi.** RP2040-over-USB-serial (`HyperSerialPico` is proven prior art) was the
*correct* answer for a Pi 4, where WS2812 forced DMA/PWM register poking. On a Pi 5 it buys nothing `dtoverlay=ws2812-pio` does not
already give and adds firmware, a serial protocol and a flashing story. **Reconsider only** for hard-realtime closed loops, or if 5
V level shifting makes a Pico worth it anyway — an electrical argument.

## Packaging & cross-compilation

**Verified by running it** — Bun 1.3.14 on x86_64 Linux, one machine, one command each:

| `--target` | Result | Size |
| --- | --- | --- |
| `bun-linux-arm64` | ELF aarch64 ✅ | 93.7 MB |
| `bun-linux-arm64-musl` | ELF aarch64 ✅ | 89.3 MB |
| `bun-darwin-arm64` | Mach-O arm64 ✅ | 63.4 MB |
| `bun-windows-x64` | PE32+ x86-64 ✅ | 98.5 MB |

```sh
bun build --compile --target=bun-linux-arm64 src/yantrad.ts --outfile dist/yantrad-linux-arm64
```

- `--bytecode` also cross-compiles (verified for `bun-linux-arm64`). Use it for CLI start-up.
- The cross-compiled arm64 output inherits **64 KB segment alignment**, so it will *load* on a 16 KB-page Pi. Whether it *runs* is
  the open question above. First build per target downloads ~90 MB — cache in CI.
- macOS binaries cross-compile from Linux and are what Oven itself ships (bun#31303, merged 2026-05-25).
- **One Linux CI runner produces every Yantra artefact** — no Mac and no Pi in the build pipeline. This is the strongest practical
  argument for Bun over Node, whose SEA cannot cross-compile at all.

## Risks & unknowns

- **UNVERIFIED, HIGHEST PRIORITY: Bun has never been publicly confirmed to run on a 16 KB-page kernel.** Day-one test, in order:
  `getconf PAGESIZE` → `bun --version` → `bun -e 'console.log(1)'` → `bun test` → **run a `--compile`d binary** → 24 h `Bun.serve`
  soak with idle-CPU sampling. If any step faults, set `kernel=kernel8.img`, reboot to 4 KB, retest. **Working only at 4 KB pages is
  still a GO** — one line in `config.txt` and ~7%. T1 fires only if both fail.
- **The Rust rewrite is the biggest unquantified risk here.** 1.4.0 is unreleased, ~1M lines changed, explicitly breaking, no
  statement on native-addon compatibility. Pin the version in the appliance image and re-run the full smoke test before adopting it.
- **Every measurement here was taken on x86_64; nothing ran on a Pi 5.** No hardware claim was executed either — the overlays are
  documented and backed by in-tree drivers, and the encoder one was demonstrated by an RPi engineer, but nobody has checked
  `/dev/leds0` byte order against a real strip. `ws2812-pio` is also "Pi 5 only, up to 4, assuming nothing else uses PIO".
- **Untested:** whether `fs.createReadStream` on a *character* device such as `/dev/input/eventN` behaves identically under Bun and
  Node — test that read path early. Likewise ControlMaster failure modes (network drop mid-command, stale socket, whether masters
  survive a daemon restart): integration-test against `ssh localhost` per §B3.

## Sources

- *All retrieved 2026-07-28.* Bun docs: [installation](https://bun.com/docs/installation.md) · [`--compile` targets](https://bun.com/docs/bundler/executables.md) · [`bun:sqlite`](https://bun.com/docs/runtime/sqlite) · [`bun install`](https://bun.com/docs/pm/cli/install.md) · [v1.3.5 native PTY](https://bun.com/blog/bun-v1.3.5) · [Rewriting Bun in Rust](https://bun.com/blog/bun-in-rust)
- Bun issues/PRs at `github.com/oven-sh/bun/issues/N` — **page size & arm64:** [#17627](https://github.com/oven-sh/bun/issues/17627) (open, the key one), #6241, #28345, #17820, #12076, [#30412 Rust rewrite](https://github.com/oven-sh/bun/pull/30412), #28792, #31303. **PTY & N-API:** [#25822](https://github.com/oven-sh/bun/issues/25822), #29112/#29114, [#33237](https://github.com/oven-sh/bun/issues/33237), #34289, #34290, #34225, [#4290](https://github.com/oven-sh/bun/issues/4290), #18546, #34146. **sqlite:** [#29821 closed unmerged](https://github.com/oven-sh/bun/pull/29821), [#32498 merged to main 2026-07-17](https://github.com/oven-sh/bun/pull/32498), #34863, #978, #31014, #28911, #34446, #5621. **ssh2-triggered:** #4487, #7130, #10425, #21807, #26418.
- SSH & PTY packages: [mscdex/ssh2#1416](https://github.com/mscdex/ssh2/issues/1416) · local `ssh_config(5)` from OpenSSH_10.4p1 · [Win32-OpenSSH#1328](https://github.com/PowerShell/Win32-OpenSSH/issues/1328) (open since 2019-01-23) · [node-pty#860](https://github.com/microsoft/node-pty/issues/860) · [sursaone/bun-pty](https://github.com/sursaone/bun-pty)
- Pi 5 primary: [`bcm2712-rpi.dtsi`](https://github.com/raspberrypi/linux/blob/rpi-6.12.y/arch/arm64/boot/dts/broadcom/bcm2712-rpi.dtsi) · [PR #6144 gpiochip0](https://github.com/raspberrypi/linux/pull/6144) · [overlays README (`rotary-encoder` L4393, `ws2812-pio` L6157)](https://github.com/raspberrypi/linux/blob/rpi-6.12.y/arch/arm/boot/dts/overlays/README) · [`ws2812-pio-rp1.c`](https://github.com/raspberrypi/linux/commit/d6d83ad3d9a3a594909a1ad1c82b735ab711cd12) · [linux#6020 SPI DMA](https://github.com/raspberrypi/linux/issues/6020) · [99-com.rules udev](https://github.com/RPi-Distro/raspberrypi-sys-mods/blob/master/etc.armhf/udev/rules.d/99-com.rules) · [PIOLib](https://www.raspberrypi.com/news/piolib-a-userspace-library-for-pio-control/) · [forums: rotary-encoder on Pi 5](https://forums.raspberrypi.com/viewtopic.php?p=2334541)
- Pi 5 libraries: [pigpio#589](https://github.com/joan2937/pigpio/issues/589) · [onoff#206](https://github.com/fivdi/onoff/issues/206) · [rpi_ws281x#528](https://github.com/jgarff/rpi_ws281x/issues/528) · [node-libgpiod#44](https://github.com/sombriks/node-libgpiod/issues/44) · [i2c-bus#130](https://github.com/fivdi/i2c-bus/issues/130) · [gdorbes/rpi-io](https://github.com/gdorbes/rpi-io) · [HyperSerialPico](https://github.com/awawa-dev/HyperSerialPico)
- Node: [TypeScript](https://nodejs.org/api/typescript.html) · [`node:test`](https://nodejs.org/api/test.html) · [`node:sqlite`](https://nodejs.org/api/sqlite.html) · [SEA](https://nodejs.org/api/single-executable-applications.html). Drizzle: [bun-sqlite](https://orm.drizzle.team/docs/connect-bun-sqlite) · [drizzle-orm#1520](https://github.com/drizzle-team/drizzle-orm/issues/1520)
- "Verified locally" ran here 2026-07-28: x86_64 CachyOS, kernel 7.1.3-2, 4 KB pages, Bun 1.3.14 release binary, Node v24.0.0,
  OpenSSH_10.4p1. `readelf -lW`/`strings` were run against the official `bun-linux-aarch64` v1.3.14 binary.
