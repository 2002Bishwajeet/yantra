# M5 — the heartbeat agent: what ADR-0013 leaves open, and what the fleet actually says

- **Date:** 2026-08-02
- **Status:** proposal, awaiting review
- **Implements:** [ADR-0013](../adr/0013-the-heartbeat-carries-only-what-placement-scores.md), which is
  still `proposed` — see §6
- **Follows:** [m4-dashboard-next.md](m4-dashboard-next.md), whose §4 named `yantra-agent` *"still a
  19-line stub that prints its version — the largest functional gap in the project"*

ADR-0013 settles the schema and nothing about the code. Four things are open, an implementer who
guesses will guess differently from the next one, and three of the four are answerable only by
measurement. This plan measures them.

**Nothing here re-opens ADR-0013** (§B0.2). Where reality turned out to differ from the page, it is
in §8, stated as a finding rather than as a revision.

---

## 0. What was measured, and what stays documented

The repo's convention: **[V]** = ran it, **[D]** = read it. ADR-0013's own Consequences section
concedes that *"the macOS and Windows halves of this schema are `[D]`, not `[V]`"*. This plan moves
the macOS half. Windows does not move, and §7 says why that is deliberate rather than an omission.

| Claim | Was | Now | Evidence |
| --- | --- | --- | --- |
| The seven fields can be read on Linux | [V] (R5) | **[V]** | §3, `cachyos-g14`, kernel 7.1.3 |
| The seven fields can be read on macOS | [D] | **[V]** | §3, `bishwajeets-macbook-pro`, macOS 26.5.1, arm64 |
| A heartbeat crosses the tailnet and is attributed by source address | [D] | **[V]** | §3.8 — a real POST from the MacBook, 204, source `100.x.x.x` |
| `Power::Ac` on a machine that is plugged in | [V] (R5, Linux) | **[V] both** | §3.6 |
| `Power::Battery` on a machine that is unplugged | [D] | **[D]** | §3.6 — both fleet machines were on AC throughout; nothing was unplugged |
| A machine with **no** battery at all | [V] per I-9 | **[D] on this fleet** | §3.6 — **the fleet has no desktop.** See §8.1 |
| axum rejects unknown keys, over-limit bodies and other verbs | [D] | **[V]** | §4, against axum 0.8.9 |
| The agent stays small | asserted | **[V]** | §1, §2 |
| Windows | [D] | **[D]** | Q4 is open by choice and this plan does not close it |

Measurement environment: `rustc 1.97.1`, the workspace's own `[profile.release]`
(`opt-level = "s"`, `lto = "thin"`, `codegen-units = 1`, `strip = true`, `panic = "abort"`), host
`x86_64-unknown-linux-gnu`, `x86_64-unknown-linux-musl` via `cargo-zigbuild`. Throwaway crates,
built outside the repo and deleted; **no `crates/` or `Cargo.toml` change is proposed by this plan.**

---

## 1. Decision 1 — the wire type lives in `yantra-core`, and the agent depends on it

The payload struct is serialised by `yantra-agent` and deserialised, strictly, by `yantrad`.
[ADR-0012](../adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md) makes `yantra-core`
the one library; R-12's whole mitigation is that this agent stays tiny. The two pull opposite ways
only if depending on `yantra-core` is expensive. **It is not, and that is the finding.**

Every row below is the same agent — the same probes, the same loop, the same hand-written POST —
differing only in what it links. `musl` is the comparable column because Y-037's archive figures are
musl.

| | Shape | crates | musl raw | musl gz | gnu raw |
| --- | --- | ---: | ---: | ---: | ---: |
| Z | a version-printing binary, nothing linked | 1 | 344 KB | 176 KB | 313 KB |
| G | std only: hand-rolled JSON, hand-written POST | 1 | 480 KB | 255 KB | 422 KB |
| **A** | **`serde` + `serde_json`, hand-written POST** | **14** | **481 KB** | **255 KB** | **424 KB** |
| H | A plus `time` for an RFC 3339 `sent_at` | 20 | 485 KB | — | 427 KB |
| **F** | **A plus a path dependency on `yantra-core`** | **38** | **492 KB** | **261 KB** | **432 KB** |
| D | A plus `tokio` (the workspace's feature set) | 24 | 614 KB | 321 KB | 559 KB |
| B | A plus `ureq`, default features off | 23 | 756 KB | 386 KB | 728 KB |
| F2 | F, but calling **one more** `yantra-core` function | 39 | 811 KB | 407 KB | 793 KB |
| E | A plus `hyper` + `hyper-util` + `tokio` | 48 | 899 KB | 453 KB | 1344 KB |
| C | A plus `reqwest` (`blocking`, `json`) | 131 | **fails to build** | — | 1873 KB |

**Depending on `yantra-core` costs 11 KB (2.3 %).** F carries 24 more crates in its tree than A —
`tokio`, `toml`, `base64`, `etcetera`, `getrandom` and their dependencies — and weighs 11,000 bytes
more, because `lto = "thin"` plus section garbage collection removes everything the agent never
calls. The dependency *edge* is nearly free.

**What is not free is the second call.** F2 differs from F by one line — it calls
`yantra_core::sessions::list()`, which reaches ssh and tmux — and it costs **+319 KB, a 65 % jump**.
So R-12's risk is real and this measurement relocates it: the thing to guard is not the `Cargo.toml`
line, it is the next `use`. That guard is cheap and belongs in the crate's own `CLAUDE.md` rather
than in a build system.

The four options, judged against those numbers:

- **The type in `yantra-core`, agent depends on it — recommended.** 11 KB, one definition, and
  ADR-0012 unchanged. It is also the only option under which ADR-0013's *"upgrade the daemon before
  the agents"* is checkable: one struct, one `deny_unknown_fields`, one place a field can be added.
- **A new shared crate.** Buys the same 11 KB saving F already gives away, and costs a fifth crate,
  a fifth `CLAUDE.md`/`tracker.md`/`llms.txt`/`README.md` set (§B5 requires all four), and a
  five-member workspace whose newest member exists to hold seven fields. §A2 refuses this.
- **Duplicated on both sides.** *Not acceptable here, and the reason is specific rather than
  stylistic.* ADR-0013 §1 deliberately has no version field and no negotiation, and pays for that
  with a loud failure — a daemon that does not recognise a key returns 422 and the fleet goes dark
  until it is upgraded. That trade is only sound while there is **one** definition to disagree with;
  two definitions turn "the daemon is older than the agents" into "somebody edited one of the two",
  which is the same outage with no way to tell what caused it. Duplication is how you would build
  this if you had a version negotiation. ADR-0013 chose not to have one.
- **A cargo feature on `yantra-core` compiling out ssh/tmux/terminfo.** Solves a problem the
  measurement says does not exist (11 KB), and buys a real one: a library that compiles two ways
  compiles the untested way in CI half the time, and §B3 already says the transport must be tested
  against reality. Revisit only if F2's ceiling is ever *approached*, and by then the fix is to stop
  calling the function.

**Where in `yantra-core`.** A new `heartbeat.rs`, not inside `inventory.rs`. `inventory` parses
someone else's unstable format and deliberately tolerates unknown fields; this is Yantra's format
and denies them. Putting both in one file puts opposite `serde` policies one screen apart, which the
crate's own notes already flag as the mistake to avoid.

**The one wrinkle ADR-0012 §84 creates.** It says the JSON wire format is *not* derived from
`yantra_core`'s types, because a JSON body is rendering and rendering lives in the caller — which is
why the read-model DTOs live in `yantrad`. That reasoning does not reach here and the plan should
say so out loud rather than look like it missed it: the DTOs are `yantrad` *rendering* a
`yantra_core` type for a browser, and the browser has no other definition of them. The heartbeat is
the opposite — the wire format **is** the contract between two Yantra binaries, and there is no
"render" step to put anywhere. It is `workspace.rs`'s situation (a Yantra schema, `deny_unknown_fields`,
one definition, both readers), not `api.rs`'s.

---

## 2. Decision 2 — a hand-written POST over `std::net::TcpStream`, and no async runtime

**Position: candidate A.** `serde` + `serde_json` for the body, eleven lines of HTTP/1.1 written by
hand, `std::thread::sleep` for the interval, no `tokio`.

§B2 says orchestrate rather than reinvent, and it is right about SSH clients and terminal
multiplexers — programs with `~/.ssh/config`, `Match` blocks, quadratic edge cases and a decade of
other people's bug reports. This is a fixed-length request to a known address whose only response is
a status code the agent barely reads. The numbers:

- **`ureq` costs +275 KB (57 %) over A**, with TLS features already turned off, for a request the
  agent could write in eleven lines. It is the smallest real client and it is still the most
  expensive thing in the binary after `std`.
- **`hyper` + `hyper-util` costs +418 KB (87 %)** and brings `tokio` with it — a work-stealing
  multi-threaded scheduler for one timer and one blocking request.
- **`reqwest` does not build for the appliance.** With default features it resolves `native-tls` →
  **`openssl-sys`**, and the musl cross-build fails outright:

  ```
  warning: openssl-sys@0.9.117: Could not find directory of OpenSSL installation, and this
  `-sys` crate cannot proceed without this knowledge.
  error: failed to run custom build command for `openssl-sys v0.9.117`
    X86_64_UNKNOWN_LINUX_MUSL_OPENSSL_LIB_DIR unset
  ```

  Y-037 built five targets green on the first attempt; this one line would end that. As measured —
  `blocking` + `json`, default TLS — it is **131 crates and 1873 KB**. Switching it to `rustls` would
  remove the C dependency and was not measured, because it does not change the argument: it is still
  a TLS stack for a link ADR-0013 §4 says WireGuard already encrypts.

**No async runtime.** `tokio` alone — with a hand-written POST, no HTTP crate at all — is
**+133 KB (28 %)** over A, to give one thread one timer. The agent has no concurrency: it measures,
it sends, it sleeps. A blocking `TcpStream` with `set_read_timeout`/`set_write_timeout` is the whole
requirement, and it means the agent has no runtime to be starved, no task to be cancelled, and no
`spawn_blocking` question when the probes shell out to `df` and `pmset`.

**What "eleven lines" actually is**, measured against a real listener (§3.8): one `TcpStream::connect`,
one `write!` of a fixed request template, one `read_exact` of the first 15 bytes, one `parse` of
bytes 9..12. `Connection: close` means there is no keep-alive state machine, no chunked decoding and
no response body to consume — the agent never reads past the status line. The risk this takes on is
the one to name: *if it ever needs redirects, retries, keep-alive, compression or TLS, this decision
is wrong and the answer is `ureq`.* ADR-0013 §4 and §7 rule out every one of those by name — no TLS,
no backoff, no queue, and a response that will never carry instructions.

**`sent_at` costs 2.7 KB.** ADR-0013's example is RFC 3339 and the repo has no time-formatting
dependency anywhere — `inventory.rs` passes Tailscale's string through and never produces one, so
this would be the first timestamp Yantra writes. Adding `time` with `formatting` is +2,776 bytes and
+6 crates (candidate H). Cheap enough that the alternative — sending epoch seconds and changing the
ADR's example — is not worth arguing for. **Take the crate.**

---

## 3. Decision 3 — the probes, measured on both machines

Every command below was run on `cachyos-g14` (Arch, kernel 7.1.3, x86_64, 12 cores, 15.0 GiB) and on
`bishwajeets-macbook-pro` (macOS 26.5.1, arm64 M1 Pro, 8 cores, 16 GiB) over ssh. Output is verbatim
with paths and identifiers sanitised.

### 3.1 `arch` — the same machine has two spellings, and Rust already picked one

```
cachyos-g14 $ uname -m
x86_64
bishwajeets-macbook-pro $ uname -m
arm64
bishwajeets-macbook-pro $ rustc --print cfg | grep target_arch
target_arch="aarch64"
```

**`uname -m` says `arm64` and `rustc` says `aarch64` on the same host.** This is the I-42/I-43/I-45/I-48
family exactly — the fleet is heterogeneous and the container cannot catch it — except that here the
disagreement is between two tools on *one* machine.

**Recommendation: send `std::env::consts::ARCH`.** It is a compile-time constant, costs no syscall and
no process, and yields `x86_64` / `aarch64` uniformly on Linux, macOS and Windows. `uname -m` yields
`x86_64` / `arm64` / `aarch64` depending on the OS, which would make `requires.arch` match a Pi and
not a MacBook for no reason a workspace author could see.

**The cost to write down**: R5's own example machines file uses `arch: arm64`, and ADR-0013's example
payload uses `x86_64`. Whichever spelling ships, **M5's hard filter 3 must compare against the
agent's spelling and the workspace schema must document it**, or the filter silently rejects the two
machines this fleet actually has.

### 3.2 `free_ram_mb` — Linux is unambiguous, macOS has two answers that differ by 2×

Linux, one file, one field:

```
cachyos-g14 $ grep MemAvailable /proc/meminfo
MemAvailable:    7625608 kB
→ 7625608 / 1024 = 7446 MB
```

macOS, one moment, two of R5's own suggestions:

```
bishwajeets-macbook-pro $ sysctl -n hw.pagesize
16384
bishwajeets-macbook-pro $ vm_stat | head -6
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     3591.
Pages active:                                 341839.
Pages inactive:                               323271.
Pages speculative:                             17855.
Pages throttled:                                   0.
bishwajeets-macbook-pro $ memory_pressure | tail -1
System-wide memory free percentage: 67%
```

- `vm_stat`: (3591 + 323271 + 17855) × 16384 = 5,647,843,328 B = **5,386 MB**
- `memory_pressure`: 67 % of 16,384 MB = **10,977 MB**

**The two formulas R5 offers side by side disagree by 5,591 MB — slightly more than 2×.** This is not
a rounding difference and it is not cosmetic: `free_ram_mb` feeds **hard filter 5** and the 20-point
*RAM headroom* score. A workspace asking for `ram_gb: 8` is refused by one formula and accepted by
the other, on the same machine at the same instant.

**Recommendation: `vm_stat`, free + inactive + speculative.** Three reasons, in order. It is the
*conservative* number, and R5's stated posture is that it is better to under-place than to place onto
a machine that cannot take it. It is a *count*, so it can be arithmetic-checked against `hw.memsize`;
`memory_pressure`'s percentage is a single rounded integer with no published definition. And it is
the closer analogue of `MemAvailable`, which is what the Linux column reports, so the two platforms
are at least measuring the same idea badly rather than two different ideas well.

**Record the residual honestly**: macOS's compressor means no single number is "free memory" there.
ADR-0013 already accepts that `cpu_busy_pct` is not comparable across operating systems; `free_ram_mb`
is a second field with the same property and the ADR does not say so.

### 3.3 `free_disk_mb` — right by luck on macOS, and it would not be if the ADR had asked for more

```
cachyos-g14 $ df -Pk /
Filesystem     1024-blocks     Used Available Capacity  Mounted on
/dev/nvme0n1p6   425438208 53933116 369973300      13%  /
→ 369973300 / 1024 = 361302 MB
```

```
bishwajeets-macbook-pro $ df -k /
Filesystem     1024-blocks      Used Available Capacity ... Mounted on
/dev/disk3s1s1   482797652  12276800  40233324    24%      /
bishwajeets-macbook-pro $ df -k /System/Volumes/Data
/dev/disk3s5     482797652 411784788  40233324    92%      /System/Volumes/Data
→ 40233324 / 1024 = 39290 MB
```

**`/` on macOS is the sealed system snapshot, a different device from where every repo lives** —
`disk3s1s1` versus `disk3s5` — and it reports **24 % used** where the volume holding `/Users` reports
**92 %**. `Available` is nevertheless identical on both, because APFS shares free space across the
container. So ADR-0013's *root filesystem only* is correct on macOS **for the one number it asks
for, and for no other number on that line.** Anything that later reads `Used`, `Capacity` or
`1024-blocks` from `/` on macOS will be wrong by a factor of four and look fine.

Two notes for the implementer. Use `df -Pk`, not `df -k`: POSIX mode guarantees one line per
filesystem, and a long device name wraps the header line otherwise. And on this Linux machine `/`
and `/home` are the **same** partition (`/dev/nvme0n1p6`), so ADR-0013's *"a repository on a
filesystem that is not `/`"* revisit trigger is not armed on either fleet machine today.

### 3.4 `cpu_busy_pct` — `min(load1/ncpu, 1) × 100`, and macOS wraps its load average in braces

```
cachyos-g14 $ cat /proc/loadavg
1.27 1.49 0.95 3/1407 1992325
cachyos-g14 $ nproc
12
→ min(1.27 / 12, 1) × 100 = 10.58 → 11
```

```
bishwajeets-macbook-pro $ sysctl -n vm.loadavg
{ 2.13 2.42 2.73 }
bishwajeets-macbook-pro $ sysctl -n hw.ncpu
8
→ min(2.13 / 8, 1) × 100 = 26.6 → 27
```

**macOS returns `{ 2.13 2.42 2.73 }` — with braces** — so `load1` is the *second* whitespace field,
not the first, and a parser written against `/proc/loadavg` reads `{` and gets zero. Zero is the
worst possible failure here, because `cpu_busy_pct: 0` is a *perfect* CPU-idle score (15 points) and
looks like an idle machine rather than a broken reader.

`hw.ncpu` is 8 and `hw.logicalcpu` and `hw.physicalcpu` are also 8 on this M1 Pro, so the three agree
here and would not on an Intel Mac with SMT. `nproc` on Linux respects affinity masks;
`std::thread::available_parallelism()` does too and works on both platforms with no process spawn —
prefer it to either command.

### 3.5 `labels` — the probe set, and the loud negative

ADR-0013 §1 says labels are *"derived from probes at agent start — `nvidia-smi` exits 0 ⇒ `gpu`"*.
Run on the fleet, that rule produces this:

| probe | `cachyos-g14` | `bishwajeets-macbook-pro` |
| --- | --- | --- |
| `nvidia-smi` | present, exit 0, `NVIDIA GeForce GTX 1650 Ti` | absent |
| `docker` | **absent** | **absent — and Docker Desktop is installed** |
| `podman` | `/usr/bin/podman` | absent |
| `nvcc` | absent | absent |
| `tmux` | `/usr/bin/tmux` | **absent — and tmux 3.7b is installed** |

**The macOS column is wrong twice, and the cause is `PATH`.**

```
bishwajeets-macbook-pro $ echo $PATH
/Users/<user>/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/<user>/.puro/bin:…
bishwajeets-macbook-pro $ ls -l /opt/homebrew/bin/tmux
lrwxr-xr-x@ … /opt/homebrew/bin/tmux -> ../Cellar/tmux/3.7b/bin/tmux
bishwajeets-macbook-pro $ ls /usr/local/bin/docker
/usr/local/bin/docker
bishwajeets-macbook-pro $ cat /etc/paths
/usr/local/bin
/System/Cryptexes/App/usr/bin
/usr/bin
/bin
/usr/sbin
/sbin
bishwajeets-macbook-pro $ launchctl getenv PATH
(empty)
```

`/etc/paths` is applied by `path_helper`, which runs from `/etc/profile` — for **login** shells.
A non-login `ssh host cmd` does not get it, and neither does a **launchd LaunchAgent**, whose `PATH`
is unset at the launchd level and therefore defaults to `/usr/bin:/bin:/usr/sbin:/sbin`. So this is
not an artefact of how the probe was run: it is exactly the environment the shipped agent will have,
and R-12's install story is what puts it there.

**Consequence, stated plainly: a `command -v`-based label probe reports `labels: []` on macOS while
Docker Desktop and Homebrew tmux are both installed** — and a machine with an empty label set fails
hard filter 4 for every workspace that requires anything, forever, silently. That is the *same* class
of defect I-9 is: not a hardware detail, a scoring bug in disguise.

**This project has already learned this once, one layer over.** `yantra_core::agent::CANDIDATES` is a
six-entry absolute-path list searched *when `PATH` fails*, and its own doc comment records the
identical measurement: **I-34**, *"`ssh <mac> 'command -v claude'` answers nothing at all."* The list
is `$HOME/.local/bin`, `$HOME/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`,
`/usr/bin`. Every path §3.5 needs is already in it.

**Recommendation: `PATH` first, then that same candidate list.** The agent should not grow a second
one — a fleet where `claude` is found and `docker` is not, because two lists drifted, is precisely
the class of bug I-34 exists to name. This is the `yantra-core` dependency (§1) paying for itself a
second time, and it is a stronger argument than the 11 KB.

**And name what each label means, because "gpu" does not survive contact with this fleet.** R5 already
warned that *"Apple Silicon has no `nvidia-smi` equivalent, so `gpu` there is a static label, not a
measurement"*, and `system_profiler SPDisplaysDataType` cheerfully reports an `Apple M1 Pro` GPU with
14 cores. If `gpu` means *has a GPU*, every machine in the fleet carries it and the filter selects
nothing. If it means *CUDA-capable*, the M1 Pro must not carry it and the probe is `nvidia-smi`.
**Recommended probe set and meaning**, the smallest that can change a placement:

| label | probe | what it asserts |
| --- | --- | --- |
| `gpu` | `nvidia-smi` exits 0 | a working NVIDIA driver — the R5 label-drift case, and the only GPU claim a filter can act on today |
| `docker` | `docker` binary found | an OCI runtime with the Docker CLI |
| `podman` | `podman` binary found | an OCI runtime that is not Docker; this fleet's Linux machine has **only** this |
| `tmux` | `tmux` binary found | every Yantra verb needs it, so a machine without it is unplaceable and the operator should be able to see that |

`cuda` from ADR-0013's example payload is **not** in the list: `nvcc` is absent on both machines and
nothing in R5's filters or scores distinguishes it from `gpu`. Adding a label nothing selects on is
the failure I-10-read-backwards exists to prevent.

**Cost, measured.** `nvidia-smi --version` takes **1.232 s** on `cachyos-g14`; `podman --version`
takes 27 ms. Labels are read once, at start, so 1.2 s of startup is acceptable — but this is the
strongest concrete argument for ADR-0013's *"measuring the fixed facts still happens once"*, and the
probe must not drift into the loop.

### 3.6 `power` — the I-9 trap reproduced live, plus a third device nobody expected

`cachyos-g14`, plugged in:

```
$ ls -1 /sys/class/power_supply/
AC0
BAT0
ucsi-source-psy-USBC000:001

$ cat /sys/class/power_supply/AC0/type       →  Mains
$ cat /sys/class/power_supply/AC0/online     →  1
$ cat /sys/class/power_supply/BAT0/type      →  Battery
$ cat /sys/class/power_supply/BAT0/status    →  Not charging
$ cat /sys/class/power_supply/BAT0/capacity  →  100
$ cat /sys/class/power_supply/BAT0/present   →  1
$ cat /sys/class/power_supply/BAT0/scope     →  (no such file)
```

**I-9's exact trap, reproduced on a machine that is plugged in and full: `status` reads `Not charging`.**
ADR-0013 §2's *"AC is never inferred from a battery's `status` string"* is not a theoretical
guardrail — the string is sitting there right now, and reading it gives the wrong answer on the one
Linux machine this project has.

**The new finding is the third device.** `ucsi-source-psy-USBC000:001` is a USB-C PD port:

```
$ cat /sys/class/power_supply/ucsi-source-psy-USBC000:001/type    →  USB
$ cat /sys/class/power_supply/ucsi-source-psy-USBC000:001/online  →  0
$ cat /sys/class/power_supply/ucsi-source-psy-USBC000:001/scope   →  System
```

**A device reporting `online: 0` while the machine is on mains.** Any reader that globs
`/sys/class/power_supply/*/online` and treats a zero as "unplugged" reports `Battery` on a laptop
running on AC. The reader must filter on `type` — `Mains` for the mains reading, `Battery` for the
percentage — and it must tolerate more devices than it knows about. A `scope` of `Device` (a wireless
mouse's battery, common on desktops) must likewise be skipped; this machine's battery has no `scope`
file at all, so absence must mean `System`.

`bishwajeets-macbook-pro`, plugged in:

```
$ pmset -g batt
Now drawing from 'AC Power'
 -InternalBattery-0 (id=<id>)	100%; charged; 0:00 remaining present: true
```

`pmset -g batt` takes **9.6 ms** (10 invocations in 0.096 s), which is affordable at 0.1 Hz. Its first
line is the mains state; the percentage is on the device line. Note the shape difference ADR-0013
does not anticipate: **§2 asks for "a battery device reporting mains offline, *and* a charge
percentage from that same device", and neither platform is organised that way.** On Linux the mains
state is on `AC0` and the percentage on `BAT0` — two devices. On macOS the mains state is a
system-wide line and the percentage is a device line. The *rule* is right and the *phrasing* is
sysfs-shaped; the implementation should read it as **two positive readings, mains-offline and a
percentage, from whatever the platform's mains and battery sources are**, and everything else is `Ac`.

**Both halves that remain [D], and why they could not be moved.**

- **The desktop case.** ADR-0013 §2 and I-9 both rest on *"desktops have no `/sys/class/power_supply/AC*`
  entry at all"*. **This fleet contains no desktop.** `cachyos-g14` is a laptop with `AC0` and `BAT0`;
  the MacBook is a laptop. R5's Linux column was executed on this same machine, which means the
  desktop half of I-9 was never executed either — I-9 is marked **[V]** in
  [`crates/yantra-agent/tracker.md`](../../crates/yantra-agent/tracker.md) and, on the evidence
  available here, at least half of it is **[D]**. **This is the loudest finding in the plan.** It does
  not make I-9 wrong — it is the well-documented sysfs behaviour, and ADR-0013 is right to design for
  it — but the tracker claims execution that this fleet cannot supply, and a fabricated `[V]` is
  worse than an honest `[D]`. A container with `/sys/class/power_supply` bind-mounted empty is the
  cheapest honest test and belongs in the probe task.
- **The `Battery` variant.** Both machines were on AC for every reading. Nothing was unplugged,
  because that is the owner's machine and not a thing to do to it in the background. **`Power::Battery`
  has never been produced by this project on real hardware**, and a task that claims to verify the
  power reader must produce it — a fake sysfs tree on Linux, and on macOS a recorded `pmset` string
  (`Now drawing from 'Battery Power'`) parsed by the same function, since a real one needs a hand on
  a cable.

### 3.7 `sent_at` — its stated purpose is currently unexercised

ADR-0013 gives `sent_at` one job: telling *"measured 9 s ago, delivered slowly"* from *"this machine's
clock is wrong"*. Measured across the fleet:

```
cachyos-g14 $ date -u  →  13:36:22.481369058Z
  macbook   $ date -u  →  13:36:22.675943000Z
cachyos-g14 $ date -u  →  13:36:22.678334057Z
```

The MacBook's clock falls inside a 197 ms round trip, so **skew is under ~100 ms and probably far
less**; both machines are NTP-synced. The field earns its place as insurance, and this plan records
that the insurance has never paid out — which is exactly the kind of thing R5's falsification test
(*"after roughly fifty real placements, check whether any signal ever changed a winner"*) should be
pointed at later.

### 3.8 The whole thing, end to end, across the tailnet

A shell implementation of §3.1–§3.6 was run on the MacBook — using **only** what a LaunchAgent's
`PATH` holds — and POSTed to a listener bound to `cachyos-g14`'s tailnet address.

What the MacBook sent:

```json
{"sent_at":"2026-08-02T13:35:31Z","arch":"arm64","labels":[],"free_ram_mb":5569,
 "free_disk_mb":39279,"cpu_busy_pct":25,"power":"ac"}
```

What the listener saw:

```
source address: 100.x.x.x (bishwajeets-macbook-pro), port 61620
POST /heartbeat HTTP/1.1
Host: 100.x.x.x:17717
Content-Type: application/json
Content-Length: 132

--- 278 bytes total ---
http_code=204  connect=0.0044s  total=0.0090s
```

- **Attribution by source address works** (§5 of the ADR): the listener sees the MacBook's tailnet
  address, which is what `Peer.TailscaleIPs` holds. No body field, no credential.
- **`labels: []`** — §3.5's finding, arriving in a real payload rather than as an argument.
- **132-byte body, 278-byte request.** ADR-0013's *"well under a kilobyte a beat"* is verified with
  seven times the headroom. The Rust candidate A binary produces a 148-byte body / 295-byte request
  on Linux, captured against the same listener.
- 4.4 ms to connect: `tailscale status` reports this peer as `direct`, on the same LAN. A
  DERP-relayed path would be slower and is precisely the occasional loss ADR-0013 §7 buys three
  intervals of tolerance for.

---

## 4. The write path in `axum`, concretely

ADR-0013 §6 lists three mitigations. All three were run against **axum 0.8.9** — the version in
`Cargo.lock` — with `deny_unknown_fields` on the payload and `DefaultBodyLimit::max(4096)`:

| Request | Status |
| --- | --- |
| well-formed heartbeat, `"power": "ac"` | **204** |
| well-formed heartbeat, `"power": {"battery":{"percent":42}}` | **204** |
| unknown key `os` | **422** — `unknown field \`os\`, expected one of \`sent_at\`, \`arch\`, …` |
| missing key `power` | **422** — `missing field \`power\` at line 1 column 137` |
| `cpu_busy_pct: "eleven"` | **422** — `invalid type: string "eleven", expected u8` |
| `cpu_busy_pct: 300` | **422** — `invalid value: integer \`300\`, expected u8` |
| malformed JSON | **400** |
| no `Content-Type: application/json` | **415** |
| 5 KB body against a 4 KB limit | **413** — `Failed to buffer the request body: length limit exceeded` |
| `GET` / `PUT` / `DELETE` on `/heartbeat` | **405, 405, 405** |
| `POST /nope` | **404** |

Five things follow, each of which an implementer would otherwise have to discover:

1. **`DefaultBodyLimit::max(4096)` is `axum`'s own** — `axum::extract::DefaultBodyLimit`, no
   `tower-http`, so ADR-0013 §6.2's *"measured in kilobytes rather than axum's 2 MB default"* costs
   **no new dependency**. 4 KB is ~30× the measured payload and still bounded; the only unbounded
   field is `labels`.
2. **`Power`'s two variants round-trip on serde's default externally-tagged representation** —
   `"ac"` and `{"battery":{"percent":42}}` — which is exactly ADR-0013's example. No `#[serde(tag=…)]`
   is needed, and adding one would change the wire format for nothing.
3. **Y-071's 405 convention is free here.** `axum`'s `MethodRouter` answers 405 for every verb the
   route does not declare, so `post(heartbeat)` gives the same shape `/api` already has. What the
   convention *implies* for this route is the inverse of `/api`: `/api` is 405-on-write because a
   write route is where Q6's absent authentication stops being free, and `/heartbeat` is the one
   place that cost has been argued for and accepted. It should therefore live **beside `/healthz` at
   the top level, not under `/api`** — `/api` is the read model, and a POST inside it would read as
   the dashboard growing writes.
4. **A rejection body echoes the schema.** `422` names every accepted field. Harmless — this is a
   public repo and the schema is in the ADR — but the daemon should not additionally log the body,
   and Q6's *"the tailnet is one trust domain"* is the assumption doing the work.
5. **`ConnectInfo<SocketAddr>` requires a change `main.rs` has not made.** The daemon currently calls
   `axum::serve(listener, app)`; the source address is only available through
   `app.into_make_service_with_connect_info::<SocketAddr>()`. That must be applied **inside the
   per-address loop**, once per listener, since the daemon binds v4 and v6 separately — and
   attribution must therefore match a peer on **either** family, because `Peer.TailscaleIPs` holds
   both and a v6-connecting agent is not a stranger.

**Where the beat lands, because the obvious answer is slightly wrong.** `snapshot::Snapshot` is
tempting and its `Reading<T>` already stamps `Instant::now()` and hands out an `age()`, which is
exactly the freshness ADR-0013 §7 wants. But `Snapshot`'s three rules are about **looks the daemon
takes** — *"a look that failed is a third answer"*, *"nobody has looked yet is `None`"* — and a
heartbeat is not a look. It arrives, it belongs to one machine, and there is no `Result` for it to
carry. **Recommended: a separate `Arc<RwLock<BTreeMap<String, Reading<Heartbeat>>>>` keyed on
`Peer.ID`** (I-5), beside the `Model` rather than inside it — so the 10 s write path does not take
the same lock four 30 s refresh tasks hold, and so `Reading` is reused for its age without
`Snapshot` acquiring a member that means something different from the other four. The counter-argument
is one lock and one clone per request; it is worth having, and it is a task decision rather than a
plan one.

**What ADR-0013 §5 needs from `yantra-core`, precisely.** `MachineInfo` carries no addresses today,
but `inventory::Node` **already parses `TailscaleIPs` for every node** — `parse_addresses` reads it
from `Self` and `From<Node> for MachineInfo` simply drops it. So this is one field on the struct, one
line in the `From`, and **three test construction sites** — `refresh.rs`, `api.rs` and
`yantra/src/main.rs` each hand-build one. Small, and worth knowing before the task is estimated.

---

## 5. The local agent, and the one value that configures it

ADR-0013 §4 gives the agent *"no flags, no config file, no state"* and one configuration: which
machine runs the daemon. I-50 says the local agent must dial the tailnet **address**, never the
MagicDNS name. Re-measured for the heartbeat specifically, on `cachyos-g14`:

| Dialled | Result |
| --- | --- |
| its own tailnet address, `POST /heartbeat` | **204**, connect in 0.27 ms; **the listener sees the source address as that same tailnet address** |
| its own MagicDNS short name | `curl` exit 7, `http_code=000` — `getent hosts cachyos-g14` returns `127.0.1.1` |

The second row is I-50. The first row is **new and is the part that mattered**: it was not obvious
that a host dialling its own tailnet address would present that address as the *source*. It does — so
the local agent is attributed by ADR-0013 §5's mechanism with no special case at all, and `yantrad`
needs no "is this me" branch. ADR-0013's claim that the local case *"is a configuration detail rather than a
second code path"* is now verified on both halves rather than one.

**Where the value comes from: the service unit, and it is an address.** A name works for four of the
five agents and fails for the fifth, which is the worst possible split — it works everywhere it is
tested and fails on the machine the developer is sitting at. So the config value is
`YANTRA_DAEMON=100.x.x.x:7717`, an address on every machine including the remote ones, and the agent
does **not** resolve names at all. Two consequences to record:

- **The agent must not call `tailscale ip` to learn it.** That is a second source for one fact, a
  dependency on `tailscaled` being up before the agent is useful, and it only works for the local
  agent anyway. It is also the exact shape ADR-0013 §5 rejected on the identity side.
- **A Tailscale address is stable per node but not immortal.** Re-authenticating or recreating the
  daemon's node changes it, and every unit on every machine then points at nothing. The failure is
  loud — ADR-0013 §7 has the agent log the first failure and then stay quiet — so the risk is that it
  is loud *once*, five machines away. Worth a line in whatever install story M7 writes.

---

## 6. ADR-0013 is `proposed`, and accepting it is the owner's

`tracker.md` §5 lists ADR-0013 as the one **proposed** decision among thirteen accepted ones, and §B5
makes accepting an ADR the owner's call rather than Claude's. Building to a proposed ADR is what was
asked for, so the work below proceeds — but **the status must be flipped before the code lands**, or
the repo ends up with shipped code implementing a decision it has not taken. That is a task row
(Y-103), it is the owner's to close, and it is the only row here that no subagent can do.

Two things this plan would flag if the ADR were being reviewed today, both of them §8 material rather
than objections: the desktop premise behind §2 is unexecuted on this fleet (§3.6), and `free_ram_mb`
is a second knowingly-imprecise field the Consequences section does not name (§3.2).

---

## 7. Install and update: out of scope, and what "done" means without it

ADR-0013's *Not decided here* excludes systemd, launchd and Windows services, and points at R-12 and
M7. **This plan keeps that exclusion**, for one reason that is not "the ADR said so": the install
story is where R-12's *"ships software to five heterogeneous machines"* actually bites, and folding
it into the milestone that first proves the agent works would make a bad result — a wrong probe on
macOS, say — indistinguishable from a bad LaunchAgent.

So **"done" for these task rows is: the agent runs in the foreground on both fleet machines, from a
terminal, and `yantrad` shows their rows in the read model.** That is a demo, it is exactly the shape
M1's walking skeleton took, and it proves everything except distribution. An agent that cannot be
*started at boot* is not finished as a product; it is finished as a milestone, and the difference
should be written into the M5 row rather than left for someone to discover.

The one thing worth carrying forward now, because §3.5 turned it up: **the LaunchAgent's `PATH` is
part of the schema.** Whatever M7 writes must either set `PATH` in the plist or accept that the label
probe finds things by absolute path — and §3.5 recommends the second, so the install story owes
nothing to the probes. That is a saving, and it is the reason the split is clean.

---

## 8. Where reality differed from ADR-0013

Ordered by how much it costs to find out late.

1. **The fleet has no desktop, so I-9's founding case is unexecuted here** (§3.6). I-9 is marked
   **[V]**; the half about a machine with no `AC*` entry cannot have been. It is well-documented
   behaviour and the design is right; the *evidence claim* is not.
2. **A `command -v` label probe returns nothing on macOS** (§3.5), on a machine that has both Docker
   and tmux installed. ADR-0013's one-line example (`nvidia-smi` exits 0 ⇒ `gpu`) reads as complete
   and is not — and **I-34 already recorded this exact measurement for `claude`**, so the agent is
   positioned to re-learn it rather than to discover it.
3. **`free_ram_mb` on macOS has two published answers that differ by 2×** (§3.2), and both are in
   R5's own table. The ADR names `cpu_busy_pct` as its imprecise field and not this one.
4. **`uname -m` and `rustc` disagree about `arch` on the same Mac** (§3.1) — `arm64` versus
   `aarch64`. The ADR gives `arch` a hard filter and no spelling.
5. **A third power-supply device exists on the fleet's Linux machine and reports `online: 0` while on
   mains** (§3.6). Neither R5 nor the ADR anticipates more than `AC*` and `BAT*`.
6. **§2's "two positive readings … from that same device" is sysfs-shaped and matches neither
   platform** (§3.6). The rule survives; the phrasing does not.
7. **Depending on `yantra-core` costs 11 KB, not the tax R-12 implies** (§1). The ADR's *"stays
   tiny"* is defended by the *call graph*, not by the dependency list — which is a different thing to
   guard.
8. **`reqwest` cannot cross-build to musl at all** (§2). The obvious HTTP client would have taken the
   release pipeline down with it, and would have looked like a CI problem.

---

## 9. Risks

- **The probes are four platforms wearing two names.** Linux and macOS differ in `arch`, load average
  format, free RAM definition, `df` semantics, power source layout and `PATH` — six of the seven
  fields. The container fixture (§B3) runs Alpine and can catch none of it, exactly as I-42, I-45 and
  I-48 all record. **Every probe task must be verified by running it on both machines**, and a green
  CI run is not evidence (I-32).
- **`labels: []` is a silent, permanent placement failure.** It fails no test, raises no error, and
  makes a machine invisible to every workspace that requires anything. The read model should render
  an empty label set as something a human notices.
- **`cpu_busy_pct: 0` from a failed parse is a *perfect* score.** Every reader in the agent must fail
  toward the pessimistic value, not toward zero — a failed load-average read should report 100, not 0,
  or the broken machine wins the placement.
- **The daemon becomes writable and the tailnet includes a phone and a tablet** (R-22, ADR-0013 §6).
  Mitigated as §4 measures, not removed. The retire condition is unchanged.
- **`yantra-core` grows a fifth caller with a different budget.** F2 says one careless `use` costs
  65 %. The crate's `CLAUDE.md` is where that guard goes.
- **Nothing here closes Q4.** Windows has no `/proc`, no `sysctl`, no `pmset` and no load average; its
  column stays `[D]` and its `cpu_busy_pct` comes from `LoadPercentage`, which ADR-0013 already admits
  is not the same measurement. **A subagent that "finishes the agent" by adding a Windows path is
  answering a question the owner deliberately left open.**

---

## 10. Suggested task rows

Format matches `tracker.md` §3. Numbered from Y-103; Y-102 is the highest in use.

| ID | Task | Depends |
| --- | --- | --- |
| Y-103 | Accept ADR-0013, or say what would change it — **owner only** | — |
| Y-104 | The wire type: `heartbeat.rs` in `yantra-core`, `deny_unknown_fields`, `Power` as ADR-0013 §2 | Y-103 |
| Y-105 | `MachineInfo` carries each peer's tailnet addresses — one field, three test construction sites | — |
| Y-106 | The probes on Linux and macOS: seven fields, absolute-path label discovery, pessimistic on failure | Y-104 |
| Y-107 | The loop and the transport: hand-written POST, 10 s, no runtime, drop-don't-queue, log once | Y-104 |
| Y-108 | `POST /heartbeat` on `yantrad`: 4 KB limit, 204, `ConnectInfo`, source-address attribution | Y-104, Y-105 |
| Y-109 | Beat age in the read model, and ADR-0013 §7's four display states | Y-108 |
| Y-110 | Verify the fleet: both agents in the foreground, both rows in the read model, `Battery` produced from a fake source | Y-106, Y-107, Y-108 |

**What can run in parallel, and what owns which file.**

| | Owns | Runs with |
| --- | --- | --- |
| Y-105 | `crates/yantra-core/src/inventory.rs` (+ 3 call sites) | anything — it touches no file below |
| Y-106 | `crates/yantra-agent/src/probes.rs` | Y-107, Y-108 |
| Y-107 | `crates/yantra-agent/src/main.rs` | Y-106, Y-108 |
| Y-108 | `crates/yantrad/src/heartbeat.rs`, `crates/yantrad/src/main.rs` | Y-106, Y-107 |
| Y-109 | `crates/yantrad/src/api.rs`, `web/src/` | after Y-108 only |

- **Y-104 is the seam and must be sequential.** Every other row either serialises or deserialises that
  struct. It is small — one file, seven fields, one enum — and splitting it would mean two rows
  negotiating a type, which is the thing this plan exists to prevent.
- **Y-106, Y-107 and Y-108 are the genuine three-way fan-out**, and the split is exactly ADR-0013's
  own seam: what the agent *measures*, how it *sends*, and how the daemon *receives*. They share only
  Y-104's type. **Y-106 and Y-107 collide on `crates/yantra-agent/Cargo.toml`** — one adds nothing,
  the other adds `serde`, `serde_json`, `time` and `yantra-core` — so Y-107 should own that file and
  Y-106 should assume it.
- **Y-109 must follow Y-108**, and not for a merge reason: ADR-0013 §7's four display states are
  *"beat within 30 s"* crossed with Tailscale's `Online`, and neither the age nor the `None`-versus-empty
  distinction exists until something writes a row. Y-097's finding applies — a read model cannot
  choose a state honestly before the state has a source.
- **Y-105 is independent of all of it** and is the one row that could land today. It is also the row
  most likely to conflict with unrelated work, since `MachineInfo` is read in four files.
- **Y-110 is the §B3 row and is not optional.** It is where the macOS column stops being this plan's
  measurement and becomes the project's, and where `Power::Battery` gets produced for the first time.

**Not proposed here**, and each for a reason already written down: install and update (§7, M7);
enrolment, which ADR-0013 leaves to M5 and which is the smallest version of the authentication
question; and any Windows path at all (Q4).
