# 16 — What the first load costs a phone

Research note for Yantra. Measured **2026-09-08** for [Y-370](../../tracker.md#3-task-board), which
asks the owner to replace the dashboard's 145 KiB first-load ceiling with a number derived from
something a person experiences. [D3 §9.1](../design/03-dashboard-surface.md) set the ceiling by
measuring the branch it was written on. [ADR-0024 §7](../adr/0024-the-dashboard-is-material-3-built-by-hand.md)
made it a failing test. Neither names a device, a link or a load time.

This note supplies the missing half. It does not take the decision.

## Summary

- **The budget measures 151,102 B and the phone downloads 271,018 B.** A cold `/` against a real
  `yantrad` is **41 requests**. The ceiling covers the 19 files `index.html` names — 56% of the
  wire. Outside it: **65,930 B of fonts**, **45,415 B of chunks the shell imports right after the
  first paint**, the HTML itself, and five API reads.
- **The link is two different links, and both are real on the owner's own tailnet today.** An
  iPhone on the home Wi-Fi reaches this machine **direct, in 4 ms**. An iPad that is not on that
  network reaches it **through DERP in Frankfurt, in 38–45 ms, with no direct path**. The budget
  has to be sized for the second one.
- **A kilobyte costs what the link says and nothing more.** Measured at four bundle sizes on four
  links, the cost per kilobyte is 0.19 ms on a direct LAN path, 0.50 ms relayed at 20 Mbit/s,
  1.66 ms relayed at 5, and 5.22 ms on Lighthouse's mobile preset — each within 3–22% of
  *bytes ÷ link rate*. **On the three faster links the byte term is smaller than the run-to-run
  spread.** Only the slowest profile produces a ceiling that constrains anything.
- **The fonts do not block text and they do block the bundle.** `font-display: swap` means no
  reader waits for a glyph, but 65,930 B still occupy the same link at the same time as the
  script. On a slow link that is what they cost.
- **The appliance re-downloads all of it on every open.** The embedded half sends no `ETag`, no
  `Last-Modified` and no `Cache-Control`; the service worker is network-first by design. Three
  consecutive visits cost 272,634 B, 272,641 B and 272,641 B. The directory half, which gets
  `tower-http`'s validators for free, costs **4,941 B** on the second visit. §3 has the runs.
- **Recommendation: *interactive within 2 s on a cold load on Lighthouse's mobile preset*, which is
  a ceiling of 200 KiB (204,800 B) over the entry, the preloads, the stylesheets and `index.html`.**
  Today's build is 152,258 B and passes with 51.3 KiB in hand. xterm in the entry still fails by
  33 KiB; every screen eager still fails by 47 KiB. §6 prices two other targets and §7 says what
  this one gives up.

## 1. How this was measured

The dashboard was built from `main` at `8168a63` with a fresh `npm ci`, then served by a **real
`yantrad`** built with `--features embed-dashboard` — the appliance's half, the one that carries
`web/dist` inside the binary.

`yantrad` binds only the addresses `tailscale ip` reports and refuses `127.0.0.1`
(`crates/yantrad/src/main.rs`), and this machine already had a daemon on port 7717. So the daemon
and the browser both ran inside a network namespace that carries the tailnet addresses on `lo`,
which is the same trick `just appliance-runtime` uses:

```
unshare --user --map-root-user --net -- bash -c '
  ip link set lo up
  for address in $(tailscale ip); do ip addr add "$address/32" dev lo; done
  ./target/release/yantrad & …'
```

The browser is Playwright's Chromium (`channel: "chromium"`, Playwright 1.63), one fresh context
per load with `Network.setCacheDisabled: true`, so every load is cold. Bytes come from the Chrome
DevTools Protocol: `Network.loadingFinished.encodedDataLength`, which is what crossed the socket,
headers included. Timings come from `PerformanceObserver` inside the page — `paint`,
`largest-contentful-paint` and `longtask`.

**The host was shared, and that is this note's largest weakness.** Other agents were running the
Playwright suite and Vitest against the same twelve cores, and `/proc/loadavg` moved between 1.2
and 33 across the runs. Two things answer that. Every cell reports **the fastest load**, never the
median, because the fastest is the one least starved of CPU and the closest this machine could get
to an idle one. And the byte sweep is **interleaved**: three rounds, each round visiting all four
sizes in turn, so a change in the host's load lands on every size rather than on one. The medians
were recorded and are two to three times larger; they measure the other agents.

The four sizes were served by a daemon restarted for each measurement, 4 sizes × 4 profiles × 3
rounds = 48 loads, plus a separate 4 × 5 run against the embedded half.

### The throttling profiles, and why these numbers

Chromium's own throttling, not a simulation: `Network.emulateNetworkConditions`, whose `latency`
is *"Minimum latency from request sent to response headers received (ms)"* and whose
`downloadThroughput` is *"Maximal aggregated download throughput (bytes/sec)"*, plus
`Emulation.setCPUThrottlingRate`, which — in Lighthouse's words for the same mechanism — *"actually
interrupts execution of CPU work at periodic intervals to emulate a slower processor"*.

| Profile | down | up | RTT | CPU | What it stands for |
| --- | --- | --- | --- | --- | --- |
| `lan-direct` | 50 Mbit/s | 20 | 8 ms | 1× | The phone on the home Wi-Fi, direct WireGuard path |
| `derp-20` | 20 Mbit/s | 5 | 45 ms | 1× | The phone off that network, relayed, with the relay generous |
| `derp-5` | 5 Mbit/s | 1 | 45 ms | 2× | The same path when the relay or the appliance's home uplink is the limit |
| `cellular-slow4g` | 1.6 Mbit/s | 0.75 | 150 ms | 4× | Lighthouse's mobile preset: the pessimistic floor |

**Where each number comes from.**

- **8 ms and 45 ms are measured, not chosen.** §2 has the `tailscale ping` output. 4 ms was the
  direct figure; 8 ms allows for a Wi-Fi radio that has to wake.
- **50 Mbit/s** is a deliberate under-statement of 802.11ac to a box on the same switch. Nothing in
  this note turns on it, because at that rate the whole first load is 32 ms of transfer.
- **20 and 5 Mbit/s bracket a number nobody publishes.** Tailscale says DERP servers *"are
  generally slower than direct connections and may offer lower maximum throughput"* and that they
  *"limit throughput to ensure fairness between everyone using the DERP server"* — and gives no
  figure. Two rates, an order apart at the low end, are honest where one guess would not be. The
  appliance also sits *"on a home connection"* ([R12](12-custom-domain-tls.md)), so its **upload**
  is the ceiling on what a phone can download from it, and residential upload is the smaller half
  of a residential link.
- **1.6 Mbit/s / 750 Kbit/s / 150 ms / 4×** are Lighthouse's mobile preset verbatim. Its 4×
  multiplier is calibrated to move *"a typical run in the high-end desktop bracket somewhere into
  the mid-tier mobile bracket"*.
- **1× CPU is not a claim that phones are free.** The tailnet this was measured on holds an
  iPhone 15 and an iPad, whose single-thread speed is within reach of this laptop's. 1× stands for
  those; 4× stands for a cheap Android. The truth for the owner's own devices is nearer 1×, and
  the note reports both so the reader does not have to take that on trust.

### How the byte sweep was built

`web/dist` was copied four times. Three copies carry an extra ES module that the entry statically
imports and `index.html` names with a `modulepreload`, whose body is random identifiers so gzip
cannot fold it away. The browser downloads it, parses it and runs it, exactly as it would a real
chunk. Measured the way `npm run budget` measures:

| Variant | First load, gzip -9 |
| --- | --- |
| `dist` as built | 151,102 B |
| `+50 KiB` | 202,140 B |
| `+150 KiB` | 304,475 B |
| `+350 KiB` | 509,343 B |

The sweep is served by the **directory half** (`YANTRA_WEB`), because the embedded half bakes
`web/dist` in at compile time and four variants would mean four Rust builds. Both halves send the
same `.gz` files, and §4 reports the embedded half's own figures beside the directory half's `+0`
cell so a reader can see how far apart two measurements of the same bytes land.

## 2. What the link really is

**Two `tailscale ping` runs, this machine, 2026-09-08:**

```
$ tailscale ping -c 3 ipad153
pong from ipad153 (100.100.238.68) via DERP(fra) in 1.08s
pong from ipad153 (100.100.238.68) via DERP(fra) in 38ms
pong from ipad153 (100.100.238.68) via DERP(fra) in 45ms
direct connection not established

$ tailscale ping -c 3 iphone-15
pong from iphone-15 (100.73.172.23) via DERP(par) in 1.561s
pong from iphone-15 (100.73.172.23) via 192.168.2.216:41641 in 4ms
```

**Both cases are real, and the difference between them is which network the phone is on.** The
iPhone was on the same Wi-Fi and went direct on the second probe. The iPad was not, and never got
a direct path at all — the relay is not a warm-up for it, it is the connection.

`tailscale netcheck` puts the nearest relay at **Frankfurt, 7.3 ms**, so a relayed path costs about
40 ms round trip rather than 4. That is a tenth of a second added to a handful of serial requests,
and it is small. **The unknown that matters is throughput, not latency**, and §1 says why no number
for it exists.

**The repo already knew which case is common and wrote it down.**
[`docs/machines.md:131`](../machines.md) says the relayed path *"is the normal case for the fleet,
not the exception"* and, in the same paragraph, that *"the relayed case is unmeasured"*. That
sentence is about two fleet machines rather than about a phone and the appliance, and **the
appliance-specific version of it has never been written**. This note does not settle it either: it
measures both, and recommends sizing for the relayed one, because that is the case a person cannot
fix by walking into the next room.

**The loud part.** If the owner's honest answer is *"I open the dashboard at home, on my own
Wi-Fi"*, then the `lan-direct` row below is the case that matters and **bytes are nearly free**:
the whole 271 KB crosses that link in about 45 ms, and a ceiling twice today's would not be felt.
The relayed rows are the reason not to write that ceiling down.

## 3. What a cold `/` actually costs

41 requests. **271,018 B on the wire**, measured on the embedded half, unthrottled.

| What | Bytes | In the budget? |
| --- | --- | --- |
| The 19 files `index.html` names | 153,878 | **yes** — 151,102 B of body, 2,776 B of response headers |
| Chunks the shell imports after first paint | 45,415 | no |
| Fonts (two of the three faces) | 65,930 | a separate 80 KiB ceiling |
| `index.html` | 1,000 | no — 859 B of body and 141 B of headers |
| Five `/api` reads, twice over | 4,795 | no |

**The 45,415 B is the finding.** `web/src/shell/Shell.tsx:28–31` wraps `Account`, `BellPopover` and
`NotificationsSheet` in `lazy()`, and then draws all three inside a `Suspense` on every page. So
the browser fetches `useTriggerFocusGuards` (14,439 B), `useOpenInteractionType` (14,193 B),
`Account` (11,334 B) and six smaller chunks a few hundred milliseconds after the ones the budget
counts. **`lazy()` around a component the shell always renders defers the request, not the
download.** `index.html` does not name them, so the budget cannot see them, and a split that looks
like a saving in the test is not one on the wire.

**What those 19 files weigh uncompressed is 488,913 B.** Until [Y-357](../plans/m14-quality-phase1.md)
landed on 2026-09-08 that is what the daemon sent, while `npm run budget` read 151,102 B and called
it the first load. The gzip ratio is **3.24×**, and the entry chunk alone is 327,376 B of it. So
every figure this note reports is one day old as a description of reality.

The `/api` reads are 4,795 B and answer in under a millisecond against a real daemon on this
machine, so nothing in the timings below is waiting on the API. They are also **served
uncompressed** — `yantrad` gzips what `npm run build` gzipped at build time, and a JSON response it
generates has no `.gz` beside it. At this size that is right.

### Every visit is a first visit, and that is the loudest thing here

The embedded half sends four response headers — `content-type`, `content-encoding`,
`content-length`, `date`. **No `ETag`, no `Last-Modified`, no `Cache-Control`, and no
`Vary`.** A browser given no validator has nothing to revalidate with, so it fetches again.
Three visits in one browser profile, against the embedded half:

```
first visit : 42 requests, 272634 B, statuses {"200":42}
second visit: 42 requests, 272641 B, statuses {"200":42}
third visit : 42 requests, 272641 B, statuses {"200":42}
```

The directory half, the same three visits, same browser, same bytes on disk:

```
first visit : 42 requests, 276220 B, statuses {"200":42}
second visit: 42 requests,   4941 B, statuses {"200":42}
third visit : 42 requests,   4802 B, statuses {"200":42}
```

`tower-http`'s `ServeDir` sends `etag`, `last-modified` and `vary: accept-encoding` for free, so the
second visit costs the five API reads and nothing else — **a factor of 55**. The hand-written
embedded half does not, **and the embedded half is the appliance's**.

**The service worker does not save it.** `web/public/sw.js` is network-first by design (R-23: *"a
cached reading is a confident lie with a longer memory"*), so it re-fetches whenever the tailnet is
reachable and answers from its cache only when `fetch` throws. That is the right rule for data. It
means the cache never makes a reachable dashboard faster.

**So on the appliance the first-load budget is not the cost of the first open. It is the cost of
every open.** That argues the budget matters *more* than the project assumed — and it also says the
cheapest large win available is not three kilobytes of JavaScript. It is `ETag` and
`Cache-Control: max-age=31536000, immutable` on the hashed assets in
`crates/yantrad/src/web/embedded.rs`, which are content-addressed by name and can never go stale.
That is a change of a few lines and it is worth more than every cut in
[the last kilobytes](../plans/m14-the-last-kilobytes.md) put together. **It is not this note's to
make**, and it needs a row.

## 4. How load time moves with bytes

**A kilobyte costs what the link says it costs, and nothing more.** The clean measure is the moment
the last script or stylesheet of the first load arrives — link only, no CPU in it. Best of three
interleaved rounds, milliseconds:

| First load | `lan-direct` | `derp-20` | `derp-5` | `cellular-slow4g` |
| --- | --- | --- | --- | --- |
| 151,102 B | 313 | 499 | 660 | 2,088 |
| 202,140 B | 325 | 517 | 702 | 2,339 |
| 304,475 B | 307 | 574 | 916 | 2,852 |
| 509,343 B | 384 | 671 | 1,224 | 3,912 |
| **measured, ms per KiB** | **0.19** | **0.50** | **1.66** | **5.22** |
| bytes ÷ link rate, ms per KiB | 0.16 | 0.41 | 1.64 | 5.12 |

The last two rows are the result. **The measurement reproduces the arithmetic on every profile**,
which is the least surprising outcome available and the one that lets a ceiling be computed instead
of guessed. It also means the four rates in §1 are doing all the work: pick a link, and the cost of
a kilobyte follows.

**What a person sees, on the profile where bytes bind.** `cellular-slow4g`, best of three:

| First load | FCP | LCP | Interactive |
| --- | --- | --- | --- |
| 151,102 B | 1,508 | 1,660 | 1,606 |
| 202,140 B | 1,796 | 1,948 | 1,890 |
| 304,475 B | 2,320 | 2,484 | 2,418 |
| 509,343 B | 3,360 | 3,516 | 3,450 |
| **ms per KiB** | **5.27** | **5.28** | **5.25** |

Every metric moves at the link's own rate. Nothing else in the page cares how big the bundle is:
the CPU work is the same 350 kB of React and router either way, so the whole difference is transfer.

**On the other three profiles the byte term is smaller than the noise.** At `derp-5`, 50 KiB is
83 ms of link time against a run-to-run spread of several hundred; at `lan-direct` it is 10 ms.
Those columns' paint figures are not reported as a slope because they do not have one — what moves
them is the host's load and the service worker's `precache()`, which re-fetches the whole shell
while the page is drawing. **That is the finding rather than a failure to measure**: above about
5 Mbit/s, bytes are not what makes the dashboard feel fast or slow.

**Today, at 151,102 B, on all four:**

| Profile | FCP | LCP | Interactive |
| --- | --- | --- | --- |
| `lan-direct` | 304 | 376 | 304 |
| `derp-20` | 432 | 484 | 432 |
| `derp-5` | 588 | 676 | 588 |
| `cellular-slow4g` | 1,508 | 1,660 | 1,606 |

The embedded half, measured separately over five loads on a busier host, read 432 / 612 / 500 on
`lan-direct` and 1,560 / 1,732 / 1,680 on `cellular-slow4g`. **The gap between those two
measurements of the same bytes is the size of this note's error bar** — about 130 ms on the profile
the recommendation rests on, and more than that on the fast ones.

## 5. Should the budget count the fonts?

**Yes for the target, no for the ceiling.**

`font-display: swap` means the block period is about 100 ms and then fallback text paints, so a
font never delays first contentful paint. That is why D3 put the fonts on a line of their own and
why ADR-0024 §7 moved that line to 80 KiB without touching the 145.

But a target expressed in seconds cannot ignore them. 65,930 B of woff2 share the link with the
script, at the same moment, on a connection where the link is the constraint. At 1.6 Mbit/s they
are 330 ms of a pipe the bundle wants. **So the arithmetic that derives a ceiling from a time
target has to include them, and the two ceilings can still be written separately** — which is what
this note recommends, because the fonts and the bundle grow for different reasons and are cut by
different people.

One detail: only **two** of the three faces are fetched on `/` — IBM Plex Mono 400 is not — while
the 80 KiB line counts all three at 80,428 B. That is the conservative way round and it stays.

`index.html` is a different case and should be counted: 859 B of gzipped body, one serial request
that every other request waits behind, and a line to add.

## 6. Three targets the owner could pick

The figure a ceiling governs becomes the entry, the preloads, the stylesheets **and `index.html`**
(§5). On the build the timings were taken on — `main` at `8168a63` — that is 151,102 + 859 =
**151,961 B, or 148.40 KiB**. The sweep's x-axis is the 19 files, so the 859 B shifts the base and
not the slope.

> This branch then merged `main`, which had moved four commits. The first load is now **152,258 B —
> 148.7 KiB**, 297 B more, and the figures below are the current build's. The derivation keeps the
> 148.40 KiB it was measured at; 297 B is 1.5 ms on the profile it is stated against.

Three sizes to hold each candidate against, measured on the current build:

- **xterm in the entry: +86,407 B.** The one thing every version of this budget has existed to
  refuse.
- **Every screen eager: +100,965 B.** The eleven route chunks together, 1,674 B for
  `SessionTerminal` up to 29,597 B for `NewSession`.
- **The colour engine in the entry: +19,187 B.** ADR-0024 §2 says it loads only for a non-sage
  seed.

### A. "First paint under a second on the link I actually have"

Stated against `derp-5`, the relayed path. Today: **588 ms**, and a kilobyte costs 1.66 ms there.
412 ms of headroom is **248 KiB**, so the ceiling is about **396 KiB**.

**What it costs the project: nothing. What it forbids: nothing.** xterm, every screen and the
colour engine all fit inside it at once, with 45 KiB to spare. **This is the honest shape of the
answer for the connection the owner has**, and it is why the target cannot be stated there. A
budget that permits everything is not a budget.

### B. "Interactive within two seconds on the worst phone I can describe" — recommended

Stated against `cellular-slow4g`. Today: **1,606 ms** interactive, and a kilobyte costs 5.25 ms.
394 ms of headroom is **75.0 KiB**, so the arithmetic gives **223 KiB**.

**Round it down to 200 KiB = 204,800 B**, spending 51.6 of the 75 KiB and keeping 23 KiB back for a
phone slower than the model. At 200 KiB the predicted interactive time is **1.88 s**.

| | bytes | against a 200 KiB ceiling |
| --- | --- | --- |
| today | 152,258 | **passes, with 52,542 B in hand** |
| xterm in the entry | 238,665 | **fails by 33,865 B** |
| every screen eager | 253,223 | **fails by 48,423 B** |
| the colour engine in the entry | 171,445 | passes |
| one more eager screen, even the largest | up to 181,855 | passes |

### C. "Interactive within one and three-quarter seconds"

The same profile, a stricter clock. 144 ms of headroom is 27.4 KiB, so the ceiling is **175 KiB =
179,200 B** and today's build has 26,942 B in hand. It refuses xterm by 59,465 B.

**It still does not refuse the colour engine**, and nothing between here and B does: a ceiling has
to be under 171,445 B for that, which is a target of about **1.70 s** — 94 ms above the measured
1,606 ms. **So there is no target in this range that both leaves the project room and keeps
the colour engine out by arithmetic.** That rule has to live in ADR-0024 §2, where it already does,
rather than in a byte count.

## 7. Recommendation

**Take B: *the dashboard is interactive within two seconds on a cold load on the worst phone we can
describe* — Lighthouse's mobile preset — and write the ceiling as 200 KiB (204,800 B), covering the
entry, every `modulepreload`, every stylesheet and `index.html`. Fonts keep their own 80 KiB line.**

**What it trades.**

- **It hands the project 51.3 KiB it does not have today**, and the build passes for the first time
  since M14 opened. That is the point rather than a side effect: `web.yml` has carried
  `continue-on-error: true` on this step since Y-353, and **a gate that is red and ignored enforces
  nothing**. A green gate that goes red on a real regression enforces everything.
- **It stops catching small growth.** One more eager screen is between 1,674 and 29,597 B, which is
  9 to 155 ms on the profile the target names, and every one of them still lands inside the two
  seconds. A budget that fails on that is measuring tidiness rather than a load time.
- **It keeps catching what a person would feel.** xterm in the entry fails by 33 KiB and every
  screen eager fails by 47 KiB — the two things the route split exists for.
- **It gives up the colour engine as an arithmetic guarantee.** ADR-0024 §2 keeps it as a rule.
- **It is stated against a phone the owner does not own.** The tailnet holds an iPhone 15 and an
  iPad, and §4 measures the dashboard interactive in 588 ms over the relay they will really use.
  The target is written for a cheap Android on bad cellular instead, and that is deliberate: it is
  the only profile where bytes bind at all, so it is the only one a ceiling can come from. Read the
  200 KiB as *a margin the owner will probably never spend*, not as a description of a bad day.

**What would change this recommendation.** If `crates/yantrad/src/web/embedded.rs` gains an `ETag`
and a `Cache-Control`, a repeat open costs the five API reads instead of 271,018 B (§3). The
first-load ceiling would then govern the first open and the open after each deploy, rather than
every open, and a looser number would be defensible. **That change is worth more than this
number**, and it is not Y-370's to make.

## 8. What could not be measured

- **The relayed path's throughput.** No DERP figure is published and this note had no second
  machine it could force onto a relay for a transfer test. §1's two rates bracket it; they do not
  measure it.
- **A real phone.** Chromium on a laptop under CPU throttling is a stand-in for an iPhone, not an
  iPhone. The repo has never run the dashboard's timings on the owner's own device, and this note
  does not change that.
- **An idle host.** Every figure is the fastest of three or five loads on a machine whose load
  average moved between 1.2 and 33. Treat the absolute milliseconds as upper bounds and the
  differences between cells as the result.
- **Anything below today's size.** The sweep pads upward from 151,102 B. The slope over that range
  is what the ceilings in §6 rest on; extrapolating far below it assumes the line stays straight.
- **What the pad costs to parse.** It is real JavaScript that the entry imports and the engine
  runs, but it is thousands of tiny functions rather than minified React, so its parse cost per
  kilobyte is not a bundle's. On the profile the recommendation rests on this does not matter — the
  measured slope there is the link's own rate to within 3%, which leaves no room for a parse term.
  On the faster profiles it may be part of why the paint figures move at all.
- **Why the paint metrics jump on the fast profiles.** `lan-direct` and `derp-20` show occasional
  1.2 s loads at sizes where the neighbouring cells are 0.3 s. The service worker's `precache()`
  re-fetches the whole shell while the page is drawing, which is the likeliest cause; it was not
  chased down, because the link-only measure in §4 is monotonic on those profiles and the byte term
  there is 10 to 25 ms.
- **HTTPS.** Everything here is plain HTTP straight to `yantrad`. A phone reaches the dashboard
  through `tailscale serve`, which terminates TLS and speaks **HTTP/2**
  ([`docs/plans/m5-control-from-the-phone.md`](../plans/m5-control-from-the-phone.md)). HTTP/2
  multiplexes, so a nineteen-file first load should fare *better* there than it does here, and the
  handshake costs one or two extra round trips once. Neither was measured.

## Sources

- Tailscale, *Connection types* — <https://tailscale.com/docs/reference/connection-types>
  (accessed 2026-09-08): DERP servers *"are reliable but have limited quality of service … they are
  generally slower than direct connections and may offer lower maximum throughput"*.
- Tailscale, *Poor performance between tailnet devices* —
  <https://tailscale.com/docs/reference/troubleshooting/poor-performance-tailnet> (accessed
  2026-09-08): *"DERP servers also limit throughput to ensure fairness between everyone using the
  DERP server"*; no figure given.
- Tailscale, *DERP servers* — <https://tailscale.com/kb/1232/derp-servers> (accessed 2026-09-08):
  no bandwidth limit is published.
- Chrome DevTools Protocol, *Network.emulateNetworkConditions* —
  <https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-emulateNetworkConditions>
  (accessed 2026-09-08): parameter units and meaning.
- Lighthouse, *Throttling* —
  <https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md> (accessed 2026-09-08):
  the mobile preset (150 ms, 1.6 Mbit/s down, 750 Kbit/s up), the constant 4× CPU multiplier and
  what it targets.
- This machine, 2026-09-08: `tailscale ping ipad153`, `tailscale ping iphone-15`,
  `tailscale netcheck`, `npm run budget -- --no-build`, and the Playwright runs described in §1.
- [`docs/machines.md`](../machines.md), [`docs/research/01-tailscale-inventory.md`](01-tailscale-inventory.md),
  [`docs/research/12-custom-domain-tls.md`](12-custom-domain-tls.md),
  [`docs/plans/m14-the-last-kilobytes.md`](../plans/m14-the-last-kilobytes.md).
