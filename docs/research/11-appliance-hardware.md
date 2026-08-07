# 11 — The appliance's hardware: does the panel need a microcontroller, a PCB, or only a printer?

Access date: **2026-08-05**. Written for [Y-152](../../tracker.md), against M8 and M9, and extending
[R6](06-runtime-feasibility.md).

> **Scope.** Three questions the owner asked on 2026-08-05, in the order in which they gate each
> other: does the panel need a microcontroller — an ESP32 or anything else; does it need a custom
> PCB; and what of the enclosure can be 3D printed. This note does **not** design the panel process
> or its socket protocol — R6 settled that shape and M8 owns it — and it does not choose components
> for the wish list in [`brainstorm.md`](../brainstorm.md), which is deliberately larger than M8.
>
> **Extended 2026-08-06 with a fourth question the first three kept deferring to** — *which box, and
> where is it bought?* §1 found that every answer above is conditional on the board being a Pi 5 and
> then left the reader with no way to act on that. **[§8](#8-what-to-buy) is that section**: what to
> buy, from which seller, at what price, and what the price does not include.

**R6 already answered the microcontroller question and its answer holds.** What this note adds is
the condition that answer depends on, one electrical constraint R6's table does not carry, a udev
shape that silently breaks the LED driver, and the enclosure work nobody has costed.

---

## Bottom line

**No microcontroller, no custom PCB, and the enclosure is the only part that has to be made — and
every clause of that sentence is conditional on the box being a Pi 5.**

R6's verdict, *"the hardware layer is file descriptors"*, is not a property of Linux or of this
project. **It is a property of RP1**, the Pi 5's southbridge, reached through device-tree overlays
the kernel loads at boot. An N100 mini PC has no GPIO header, no RP1 and no device tree. On that box
there is no overlay to reach for, so a microcontroller stops being an alternative and becomes the
only path — and M8 stops being roughly 150 lines of Rust over three file descriptors and becomes a
firmware project with a serial protocol and a flashing story.

**So [Q15](../../tracker.md) — *"which box, and does it change the target?"* — decides M8's
architecture and not only M7's build target.** Q15 is currently argued on SD-card durability, idle
power and `just appliance*` building `aarch64` alone. Those are real and they are the smaller half.
The Pi 5 prior is correct, and this is a much stronger reason for it than the three the question
gives.

Everything below assumes the Pi 5. Where a finding survives the N100 branch, it says so.

---

## 1. The microcontroller question, and the ESP32 specifically

**On a Pi 5 you can use an ESP32, and you should not.** R6 reached this for the RP2040 and the
reasoning transfers unchanged: on a Pi 4 an external microcontroller was the *correct* answer,
because WS2812 forced DMA and PWM register poking; on a Pi 5 it buys nothing `dtoverlay=ws2812-pio`
does not already give, and adds firmware, a serial protocol and a flashing story to a box whose
entire value proposition is being up unattended.

**If Q15 lands on the N100, an MCU is mandatory — and the ESP32 is still probably the wrong one.**
Its differentiator over the alternatives is Wi-Fi and Bluetooth, which in this design is a
liability rather than a feature. [`brainstorm.md`](../brainstorm.md)'s own control-plane rule is
*"no client talks directly to another machine — everything goes through the control plane."* A panel
with a radio is a second network path into the appliance that has to be paired, authorised and kept
patched, in order to talk to a board it is physically bolted to over USB. The radio is a
liability the USB cable does not have.

On that branch the **RP2350 / Pico 2** fits better: PIO blocks — the same idea RP1 uses for
`ws2812-pio`, so the LED approach transfers rather than being rewritten — around 20 mA idle,
cheaper, and no radio to remember to disable. If an ESP32 is chosen anyway, use an **S3**: it has
native USB, where the original ESP32 needs a CP2102-class bridge.

**Reconsider an MCU on a Pi 5 for exactly two reasons, both electrical rather than architectural** —
a hard-realtime closed loop, of which this design has none, or if level shifting (§3) makes a Pico
worth having anyway. That is R6's own reservation and it is unchanged.

---

## 2. The overlays, verbatim

R6 cites these by README line number, which has already moved once. Quoted here from
`raspberrypi/linux` `rpi-6.12.y`, retrieved 2026-08-05, so that the parameter names are in the repo
rather than behind a link:

```
Name:   ws2812-pio
Info:   Configures a GPIO pin to drive a string of WS2812 LEDS using pio. It
        can be enabled on any RP1 GPIO in bank 0 (0-27). Up to 4 are supported,
        assuming nothing else is using PIO. Pi 5 only.
Load:   dtoverlay=ws2812-pio,<param>=<val>
Params: brightness   (range 0-255, default 255) — a multiplier, changed at runtime by writing a
                     single byte to offset 0 of the device. Setting it to 0 activates pass-through
                     mode, disabling all brightness and gamma processing.
        dev_name     name for the /dev/ entry; '%d' is replaced by the instance number
                     (default 'leds%d')
        gpio         output GPIO (0-27, default 4)
        num_leds     number of LEDs (default 60)
        rgbw         each pixel includes a white LED as well as R, G and B (default 'off')
```

```
Name:   rotary-encoder
Load:   dtoverlay=rotary-encoder,<param>=<val>
Params: pin_a, pin_b        GPIOs for channels A and B (defaults 4 and 17)
        relative_axis       register a relative axis rather than an absolute one; generates only
                            +1/-1 events, so no steps need be passed
        linux_axis          input-subsystem axis (default 0 — ABS_X / REL_X)
        steps-per-period    stable states per period: 1 full (default), 2 half, 4 quarter
        steps               steps in a full turn, absolute axis only (default 24)
        encoding            "gray" (default) or "binary"
        rollover, wakeup
```

Three things in that text are worth having read before wiring anything:

- **`dev_name` exists.** R6 says the node is `/dev/leds0`; that is the default, not a fixed name.
- **`brightness=0` is not "off"** — it is pass-through mode, disabling gamma processing. A panel
  that dims to zero by writing brightness has instead turned the gamma curve off at full output.
- **`steps-per-period` defaults to full-period, and the right value is a property of the encoder,
  not of this document.** A detented EC11 does not necessarily produce one event per detent at the
  default. This is measured against the encoder in hand — one `evtest` run — and not guessed. It is
  the single most likely reason a first prototype counts double or half.

---

## 3. The one electrical constraint R6's table does not carry

**Pi 5 GPIO is 3.3 V. A WS2812 powered at 5 V does not reliably read 3.3 V as a `1`.** The datasheet
figure usually quoted is V<sub>IH</sub> = 0.7 × V<sub>DD</sub>, which is **3.5 V at V<sub>DD</sub> =
5 V** — above what the pin can produce. It very often works anyway, which is what makes it a bad
bug: it presents as an occasional wrong first pixel or an intermittent colour glitch, on a device
that is meant to run for months.

R6's table says *"userspace has no timing responsibility"*, and that is true and is about the
protocol. It is silent on levels. Two fixes, both cheap:

- **Buffer the data line** with a `74AHCT125` or `74AHCT245` — an HCT-family part, chosen because
  its input threshold is TTL-compatible so it accepts 3.3 V while driving 5 V, and it is fast enough
  for the 800 kHz signal.
- **Or drop the strip's supply** to roughly 4.3–4.5 V, typically with a series diode, which lowers
  V<sub>IH</sub> to about 3.0–3.15 V and brings 3.3 V inside spec. Fewer parts, slightly dimmer
  LEDs, and it stops being an option if anything else on the strip's rail needs a true 5 V.

**This is the strongest argument for the M9 PCB** (§5), and the one case R6 names where a Pico could
be worth having for electrical rather than architectural reasons.

---

## 4. A udev rule shape that silently breaks `/dev/leds0`

R6 correctly says `/dev/leds0` ships `root:root 0600` with no rule of its own and that one must be
added. **The shape of that rule matters, and getting it wrong looks exactly like a broken driver.**

A rule matching the PIO subsystem by glob —

```
SUBSYSTEM=="*-pio", GROUP="gpio", MODE="0660"
```

— leaves the driver loading cleanly and the LEDs dead. It was reported as a kernel fault, against
two kernels in succession — 6.12.40 and then 6.12.55 — before being traced to the rule; removing it
was the entire fix. Use R6's form, which matches the device node and not the subsystem:

```
KERNEL=="leds[0-9]*", GROUP="gpio", MODE="0660"
```

**Reported loudly per [§B6](../../CLAUDE.md): the symptom here is indistinguishable from a driver
bug, and the public record contains at least one long thread that started as one.** If `/dev/leds0`
exists, the module is loaded, and nothing lights up, check the udev rules before the kernel version.

**One loose end left loose.** A separate community source claims a fix for the `ws2812-pio` module
landed in kernels *above* 6.12.55, which would mean a real driver bug existed alongside the udev
one. That was not corroborated against a kernel commit and is **not relied on here**; it is recorded
so that a board still misbehaving after the udev rule is checked has somewhere else to look.

---

## 5. The custom PCB, and why it should probably not be a HAT

The tracker already puts the PCB in **M9, after M8**, and that ordering is the finding. Three staged
forms, of which skipping to the third is the standard way to fabricate a board that is wrong:

1. **Jumpers on the header** — M8. This is what proves the overlays, the evdev codes, and the byte
   order of `/dev/leds0` against a real strip, which **R6 explicitly flags as unverified by anyone.**
2. **Perfboard** — the same circuit soldered, once it is known to work. Survives being carried.
3. **PCB** — M9.

**A HAT is a specification, not a synonym for "a board that plugs onto the header."** HAT+
compliance requires an ID EEPROM at I²C address `0x50` on the ID_SD/ID_SC pins (GPIO0/GPIO1), with
3.9 kΩ pull-ups to 3.3 V; those two pins are reserved for exactly that and nothing else may connect
to them. What the EEPROM buys is the firmware reading it at boot and auto-loading the overlay.

**For a one-off appliance that is a poor trade.** Three `dtoverlay=` lines in
`/boot/firmware/config.txt` do the same job, are visible, are diffable, and are already how M7's
install path will configure the box. Skipping the EEPROM means the board is not a HAT and should not
be called one — and costs nothing this project wants.

**What the PCB actually buys:** the level shifter of §3, a real connector for the encoder instead of
jumper wires, a series resistor on the LED data line, decoupling, and mounting holes that line up
with the printed panel. **Reliability and neatness, not capability** — which is precisely why it
belongs after the thing works.

**Cost is not the constraint.** Bare 2-layer prototype fab is advertised from about $2 for five
boards with fabrication in as little as 24 hours. Assembly is priced differently — each new design
carries a one-time NRE and stencil charge — so for a board of this size, hand-soldering is faster
than the paperwork.

---

## 6. The enclosure: measured dimensions, and the two official warnings

Every number here is from the current Raspberry Pi product briefs, read directly rather than from a
community summary. **That distinction earned itself during this note**: the Active Cooler's height
is widely repeated as 30 mm, which is its *fan* dimension. The real figure is less than half that.

| | Measured | Source |
| --- | --- | --- |
| Pi 5 board | **85 × 56 mm** | Pi 5 product brief, published April 2026 |
| Mounting holes | **ø2.7 mm, on a 58 × 49 mm pattern, 3.5 mm in from the edges** — M2.5 | same |
| Active Cooler footprint | **63.50 × 42.50 mm** | Active Cooler product brief |
| Active Cooler height above the board | **13.70 mm** (its blower is 30 × 30 mm — *this* is the 30) | same |
| Operating temperature | **0 °C to 70 °C** | Pi 5 product brief |

**Both briefs carry the same warning, and for an always-on appliance it is a design constraint
rather than boilerplate:** *"This product should be operated in a well ventilated environment, and
if used inside a case, the case should not be covered."* The Active Cooler brief adds that its metal
parts may become hot in operation. A sealed premium-feeling box is the failure mode this milestone
is most likely to walk into.

**And a caveat that matters more than any single number**, printed on both drawings: *"All
dimensions are approximate and for reference purposes only. The dimensions shown should not be used
for producing production data."* Model to these figures; verify the first print against the physical
board before cutting a second.

### What is printed

Roughly in order of how much each part improves the result:

1. **LED diffuser.** The highest-value printed part by a distance. A 0.8–1.2 mm wall in natural or
   white filament turns visible individual pixels into a glow, and is most of the difference between
   *a Pi with a strip taped to it* and an appliance.
2. **Front panel.** OLED window, encoder shaft hole with clearance for its nut, diffuser slot. Keep
   it 2.5–3 mm thick where the encoder nut clamps.
3. **Chassis tray.** Board mounts, cable exits, and the vent path the warning above requires — the
   grille is structural to the design, not decoration.
4. **Encoder knob.** The part actually touched, so print it more than once.
5. **Light pipes**, if any status LEDs are separate from the strip.
6. **Cable strain relief** at the entry.
7. **Feet**, in TPU, so an always-on box does not buzz against a desk.

### What it is printed in

**Not PLA.** Its glass transition is commonly given as 55–65 °C and it *creeps* — deforming slowly
under sustained warmth and load rather than failing outright, which is the worst behaviour for a
part that is fine at the end of the build and sagging six weeks later next to a fan exhaust.

**PETG** is the right default; supplier figures put its heat-deflection point around 70 °C, it is
tough, and it prints without an enclosure. **ASA** buys real margin — figures around 90 °C — plus UV
stability, at the cost of needing ventilation while printing. The diffuser can be anything, as it
carries no load.

> These temperature figures are **supplier and community numbers and vary by grade**; they are
> quoted here to rank the materials, not as measurements. Nothing in this note was tested.

### Two details worth getting right the first time

- **Heat-set inserts**, not printed threads. For M3 the commonly published pilot is **4.0–4.2 mm**,
  with roughly 0.75 mm of relief below the insert in a blind hole to take displaced plastic. Print a
  test coupon with a range of hole sizes — this varies by printer and by material, and every source
  consulted says to measure rather than trust the chart.
- **Slip fits at 0.2–0.3 mm clearance.**

---

## 7. What in `brainstorm.md` is not M8

[`brainstorm.md`](../brainstorm.md) lists NFC, a fingerprint reader, a speaker, Zigbee, a
touchscreen, e-ink and environmental sensors. It is the founding-intent document and says so at the
top; **M8's definition narrowed it to three things on purpose**, and each additional peripheral is
another device path, another permission group and another failure mode on a box whose whole value
proposition is being up.

- **The touchscreen is the one to resist hardest.** The dashboard already runs in a browser over the
  tailnet and M6 is putting a live terminal in it. A 3.5" panel re-implements, worse, what the phone
  in your pocket already does. **The physical controls earn their place by not being a screen** — a
  knob turned without looking is a different interaction, not a smaller one.
- **E-ink is wrong for a live panel** and right for a static one: 2–5 s full refresh and 0.3–1 s
  partial (R6), plus ghosting. Good for *which workspace is open*; unusable for anything moving.
- **NFC is the one with a real interaction story** — tap a tag, open a workspace; PN532 over I²C.
  Genuinely good, and genuinely not M8.

---

## 8. What to buy

*Added 2026-08-06. Everything above answers what the panel is made of; none of it says what to put
the panel on, from which seller, or at what price. This section does.*

**The requirement this section is written against**, which §1–§7 were not: one box, **under €120 for
the board, its storage and whatever else it takes to boot**, sourced anywhere in the EU or from a
Chinese seller if that is genuinely cheaper, second-hand acceptable, running 24/7 so that **idle draw
is the number that matters and peak is not**, and enclosed in a printed case rather than a bought one.

> **Every price below was fetched on 2026-08-06 and none of them will age well.** The memory market
> is the reason (§8.1). Re-check before ordering; a price in this file is evidence of what a shop
> asked on a day, not a quote.

### 8.1 The thing that changed since §1–§7 were written: a Raspberry Pi 5 is not a cheap board any more

**Raspberry Pi has raised prices three times in eight months, and the cause is DRAM.** From
raspberrypi.com's own announcements: a **1 GB Pi 5 was introduced at $45 on 2025-12-01** alongside
rises on everything larger; on **2026-02-02** a second round added *"$10 on 2GB, $15 on 4GB, $30 on
8GB, $60 on 16GB"*, attributed to *"an unprecedented rise in the cost of LPDDR4 memory, thanks to
competition for memory fab capacity from the AI infrastructure roll-out"*, with the note that *"the
cost of some parts has more than doubled over the last quarter"*; and on **2026-04-01** a third added
*"$25 on 4GB, $50 on 8GB, $100 on 16GB"*. The 16 GB board's official price on 2026-08-06 is **$305**,
against $120 at launch.

**The one sentence in all of that which decides this purchase** is from the 2026-04-01 post: *"we've
been able to hold the price of Raspberry Pi 400 with 4GB of memory at $60, and the 1GB and 2GB
variants of Raspberry Pi 4 and Raspberry Pi 5 at between $35 and $65."* **The small-memory boards are
deliberately price-protected and the large ones are not** — so the cheapest Pi 5 is no longer merely
the cheapest, it is the only one whose price has held while the rest tripled.

German retail on **2026-08-06**, from [BerryBase](https://www.berrybase.de) product pages, VAT
included:

| Raspberry Pi 5 | Price | Stock, as shown |
| --- | --- | --- |
| **1 GB** (`RPI5-1GB`) | **€46.90** | 100+ |
| **2 GB** | **€68.90** | in stock |
| 4 GB | €118.50 | **1 piece** |
| 8 GB | €184.90 | in stock |
| 16 GB | €308.90 | in stock |

[Welectron](https://www.welectron.com) independently lists the 1 GB at **€46.90** the same day, the
4 GB at €113.90–117.00, the 8 GB at €189.00 and the 16 GB at €331.00 — two shops, one story.

**A 4 GB Pi 5 alone now costs the whole budget**, and BerryBase had one of them. So the question
"which Pi" is settled by arithmetic before anything else is weighed: **1 GB or 2 GB, or no Pi.**

### 8.2 What the workload actually needs, from this repo's own numbers rather than a guess

- **`yantrad` cross-compiled for the appliance is 3.5 MB, or 4.1 MB with the dashboard inside it** —
  the one file M7 copies. `yantra` is 1.2 MB and `yantra-agent` 432 KB. Measured 2026-08-05 by
  `just appliance-size` and recorded in [`docs/development.md`](../development.md).
- [ADR-0004](../adr/0004-rust-for-the-daemon.md) chose Rust partly on *"a ~5 MB static musl binary
  and ~15 MB idle RSS, for a device meant to run continuously for years."* The binary half is
  measured and inside its target.
- **The RSS half is not measured, and [Y-149](../../tracker.md) is the open row that measures it.**
  So the honest statement is that this design *targets* ~15 MB resident and nobody has confirmed it.

**On any of those readings, memory is not what this box is short of.** A 1 GB board holds a headless
64-bit OS plus a daemon targeting ~15 MB with three orders of magnitude to spare. The reason to buy
2 GB is not `yantrad`; it is the *"tiny other things"* beside it, and specifically that
[`CLAUDE.md`](../../CLAUDE.md) §B2 names `docker` as intended scope — **a 1 GB board is the variant
that forecloses that**, and it is the only argument for the larger one that survives contact with the
measurements.

### 8.3 The storage decision, and the R6 sentence that no longer means what it says

[R6](06-runtime-feasibility.md) says, and [Q15](../../tracker.md) quotes it as an argument for the
N100: **"SD cards, not SQLite, are the durability risk: put the database on NVMe."**

**There is no database.** [ADR-0004](../adr/0004-rust-for-the-daemon.md)'s amendment of 2026-08-02
(Y-044) records that the session store was dropped without being built, `rusqlite` is in no
`Cargo.toml` and no `Cargo.lock`, and [`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md)
states it flatly: *"Nothing is persisted."* R6's sentence was written on day 0, against a design that
had a datastore in it.

**This is not a licence to ignore SD wear, and it does change its size.** What still writes to the
card is the operating system — journald, package updates, the workspace TOML — and not an
application write path. That is a *tunable* rather than a *requirement*: a box that logs to RAM and
updates rarely writes very little. **The consequence for this purchase is that NVMe stops being
something the design needs, and becomes something the budget may buy if it is free.** It is not free:

| Storage option | Price, BerryBase 2026-08-06 |
| --- | --- |
| SanDisk High Endurance microSDXC **64 GB** | **€27.90** |
| SanDisk High Endurance microSDHC 32 GB | €27.50 |
| SanDisk Max Endurance 64 GB | €52.90 |
| Raspberry Pi branded A2 32 GB / 64 GB | €17.60 / €28.80 — **both sold out** |
| Official Raspberry Pi M.2 HAT+ (Welectron) | €11.90 |
| Third-party M.2 HAT for Pi 5, M-Key | €12.50 |
| Geekworm X1001 | €12.93 |
| Pimoroni NVMe Base | €16.90 |
| Intenso 250 GB NVMe, **2280** | €47.29 |
| Silicon Power P34A6X 256 GB, 2280 | €50.99 |
| SK Hynix BC901 256 GB, **2242** | €49.90 |
| Transcend MTE300S 256 GB, **2230** | €109.00 |

**Buy the 64 GB endurance card, because it costs €0.40 more than the 32 GB one.** That is not a
recommendation about capacity; it is what the shelf looked like on the day, and it is the kind of
fact that inverts without warning — NAND is in the same squeeze as DRAM, which is why the two
cheapest cards on that list are the ones nobody can ship.

**NVMe does not fit, and now the arithmetic says so rather than the prose.** The cheapest credible
stack is a HAT at **€11.90** plus a 2280 drive at **€47.29** — about **€59** before the board. Added
to the 1 GB Pi 5 with its supply and cooler that is **€124.39**, and to the recommended 2 GB basket
**€146.39**. **Both are over the ceiling, and the smaller of them is over it while buying the board
this note otherwise treats as the fallback.** So the honest answer to *does NVMe fit under €120
alongside the board* is **no**, at any combination checked on 2026-08-06.

**Two form-factor traps, since a HAT's slot length is not a detail.** The **official M.2 HAT+ takes
2230 and 2242 only** — and 2230 is where the German shelf has emptied out, leaving the Transcend
MTE300S at **€109.00** as the only buyable 256 GB, a **~2.3× premium over the same capacity in
2280**. **2242 is the way out**: an SK Hynix BC901 256 GB at **€49.90** fits the official HAT, which
is also the one designed to coexist with the Active Cooler via a 16 mm stacking header. A third-party
HAT taking 2280 is cheaper per gigabyte and is a different mechanical problem for a printed case.

And the reason to want any of it — a database — was deleted from this project four days before this
note was first written. **So the power question below is very likely moot for this build**, and is
recorded because it will not be moot for the next one.

> **What nobody has measured, and it is not a small gap.** There is **no published same-system A/B of
> Pi 5 idle draw with and without an NVMe drive attached**. The *"+1–2 W"* figure that circulates is
> an estimate in a summary table, not a measurement — and the Pi cannot settle it itself, because
> **`pmic_read_adc` does not see the 5 V rail**, which is where the drive's draw lands. Two
> independent sources say so. **The instrument that would settle it is an inline USB-C power meter**,
> and until somebody puts one on this, any number here would be an average of forum posts. The
> closest thing to a reading found anywhere is a Pimoroni forum post putting a Pi 5 with an NVMe Base
> and a drive at roughly **550 mA, about 2.75 W in total** — which is close enough to a bare Pi 5's
> idle to be interesting and has **no matched baseline on the same board**, so it cannot carry the
> claim it looks like it carries.
>
> **Worse, the usual fixes cut against the requirement.** The two workarounds every flaky-NVMe thread
> recommends both *raise* idle draw: `pcie_aspm=off` increases board-level consumption by a Raspberry
> Pi engineer's own account, and `nvme_core.default_ps_max_latency_us=0` pins the drive out of the
> PS3 and PS4 states — 0.05 W and 0.008 W — and into its 3–8 W operational class. **So R6's durability
> answer and this box's efficiency requirement can pull against each other**, and which wins is not
> knowable from the literature.

**The third option is a USB SSD, and it is the cheapest way to leave the SD card** — €45.99 for a
ready-made Netac 250 GB, against **€60.88** to build the same thing from a €13.59 Digitus enclosure
and a €47.29 drive. **Buy the ready-made one** unless the specific bridge chip matters; assembling it
costs €15 more to get a part you chose. Even so it is €46 on top of a board that has already spent
the budget, and a USB enclosure is one more thing to fit inside a printed case.

**The recommendation is therefore the A2 endurance card, with R6's caveat attached rather than
answered.** SD wear is real, it is now the OS's writes rather than an application's, and the card is
the part of this build most likely to be the thing that fails first.

### 8.4 Idle power, measured — and the arithmetic that stops it deciding anything

| Machine | Idle | How measured |
| --- | --- | --- |
| **Pi 5 2 GB (BCM2712 D0)** | **2.4 W** | Jeff Geerling, board-level, against 3.3 W for the 4 GB C1 and 3.2 W for the 8 GB |
| Pi 5, headless on Wi-Fi | ~2.7 W | [raspberry.tips](https://raspberry.tips/en/raspberrypi-tutorials/raspberry-pi-power-consumption-update-2026-all-models-compared), 2026-07-28, **at the wall, PSU losses included** |
| Pi 5, Ethernet + USB + HDMI | ~3.6 W | same |
| Pi 4 4 GB | ~2.9 W | same — **the Pi 4 idles higher than the Pi 5** |
| Fujitsu Futro S740 (J4105) | 2.9 W claimed, ~5 W in daily use | one author's own meter, two posts two years apart; plan on the higher figure |
| Dell Wyse 5070 (J4105) | ~4 W | parkytowers.me.uk, method not stated |
| Fujitsu Futro S920 | **7.8 W** | weisser-zwerg.dev, at the wall |
| HP t620 / t630 | ~8 W / ~12 W | parkytowers.me.uk |
| Lenovo M710q / M720q Tiny | **11–14 W** | ServeTheHome, at the wall |
| N100 mini PC | **10–14 W** | CNX Software, ServeTheHome, heise — the three sources that state a method |

**Two findings here are worth more than the table.** The first: **the D0 stepping matters more than
the RAM size.** Geerling delidded both and found the D0 die 32.5% smaller than the C1, with idle
power falling almost exactly in step — so the cheapest Pi 5 is also the coolest-running one, which is
the opposite of the usual shape. The 1 GB board is D0 too, per the 2025-12-01 announcement's *"BCM2712
D0 stepping"*; **its idle draw is inferred from that and not measured anywhere I could find.**

The second: **an N100 is not the efficient x86 option — a seven-year-old Celeron thin client is.**
Every source with a stated methodology puts an N100 box at 10–14 W, four times a Pi 5, because the
N100's *"6 W"* is a package base power and vendors configure the machine at 20 W PL1. Hobby blogs
claiming 6–7 W do not state a method and disagree with the sources that do.

**Now the arithmetic.** German household electricity averaged **37.0 ct/kWh in April 2026** (BDEW),
so **1 W held for a year costs €3.24**. The gap between a Pi 5 at ~2.7 W and a Futro S740 at ~5 W is
about 2 W, which is **€7.40 a year** — and the purchase-price gap between them is roughly €65. **The
efficient box takes about nine years to repay the cheap box**, which is longer than this appliance
will be interesting. **So idle power does not decide this**, and any argument that leans on it —
including Q15's own *"costs more idle power"* — is smaller than it looks. It decides only against the
Lenovo Tiny and the N100, where the gap is 8–11 W rather than 2 W.

### 8.5 The real alternative: a used thin client with a microcontroller on USB

**§1 of this note overstated the case against the non-Pi box, and this section corrects it.** It said
that without RP1 "a microcontroller stops being an alternative and becomes the only path", and
allowed that to read as *impossible*. A microcontroller on USB costs about €5 and it is not
impossible; **the honest question is what it costs as surface, not whether it can be done.** Here is
the accounting, with the parts that collapse separated from the parts that do not.

**The encoder half collapses almost entirely, and this is the finding to lead with.** An MCU running
a USB HID firmware is handled by the kernel's own HID stack, which — per
[the kernel's HID documentation](https://docs.kernel.org/hid/hidintro.html) — *"is in charge of
parsing the HID report descriptors, and converts HID events into normal input device interfaces"*,
where *"all the input data sent by the device should be translated into corresponding evdev events"*
and *"one `/dev/input/event*` is created for each Application Collection."* **That is the same
interface `dtoverlay=rotary-encoder` would have handed over**, reached with no host-side driver, no
custom protocol and no parsing. On the encoder, the Pi 5's advantage is close to zero.

**The LED half does not collapse, and the reason is more interesting than "no driver exists".** The
USB-IF's own base-class list has no class for pixel data — checked end to end, no hit for LED, lamp
or illumination. **A real standard does exist and Linux does not implement it**: HID's *Lighting And
Illumination* usage page **0x59** defines `LampArray`, whose `LampArrayKind` explicitly covers strips,
and there is **no `hid-lamparray` in mainline or in `linux-next`** — the pending patch is single-zone
and so useless for per-pixel work anyway. Windows has shipped the full stack for years. **This is a
Linux gap rather than a spec gap**, which is worth knowing before anyone concludes the hardware is
the problem.

So the LED half is a vendor protocol over CDC-ACM — and **R6 already names working prior art for
exactly this**, `HyperSerialPico`, which it calls *"proven prior art"* and describes as the *correct*
answer on a Pi 4. Adalight and TPM2 are the two framings OpenRGB already speaks. A solved problem
with reference implementations, then, but a written protocol rather than a `write()`.

**One more thing nobody should assume in the other direction: there is no WS2812 driver in mainline
Linux at all.** `/dev/leds0` is a Raspberry Pi downstream driver whose overlay is gated on
`compatible = "brcm,bcm2712"` and which sits on RP1's PIO block. **A Pi 4 or a Zero 2 W cannot load
it** — that is a hard compatible-string mismatch, not a warning — so the fallback there is
`rpi_ws281x`, which wants root, conflicts with onboard audio, and on a Pi 4 needs a pinned
`core_freq`. **The overlay is a property of one board, not of the Raspberry Pi brand.**

**What genuinely does not transfer, stated as surface rather than as difficulty:**

- **A second deployable artifact on a second toolchain.** This is the strongest argument against the
  MCU path and it is specific to this repo rather than general: **M7's entire thesis is one file to
  copy**, and its install path, its update path and `yantrad.service`'s `Restart=on-failure` cover
  exactly one binary. A firmware image is a second artifact that none of that machinery reaches. That
  is a different objection from *"it is harder"*, and it is the one that counts.
- **A host↔MCU wire protocol** with framing, versioning, and recovery across USB re-enumeration —
  which happens on every reboot and every resume, not only on failure.
- **A stable device path.** `/dev/ttyACM0` renumbers; the fix is a udev rule keyed on the MCU's
  serial, or `/dev/serial/by-id/`. Small, and it is one more thing that is not there by default.
- **The language cost is lower than it looks.** `rp-hal` and `embassy` mean the firmware is Rust, so
  it stays inside this project's rule about only using languages the owner can maintain. It does not
  become a C++ project.

**The flashing story is better than §1 assumed and worse than it first looks, and the second half is
the one to read.** BOOTSEL is a button, and a headless appliance inside a printed case is the worst
possible place for one. `picotool` appears to remove it: `-f` is *"force a device not in BOOTSEL mode
but running compatible code to reset so the command can be executed"*, and `picotool load -f -x`
loads and then executes. **Read the condition in its own README, because it is the whole thing:**

> *"Running commands with `-f/F` requires compatible code to be running on the device… **Is still
> running** — If your code has returned then rebooting with `-f/F` will not work… **Uses
> stdio_usb**…"*

**So the recovery mechanism lives inside the thing that breaks.** Two failure modes, and they are not
equally likely. Firmware that fails the bootrom checksum — a corrupt image, a blank flash — drops to
USB boot on its own after 0.5 s and needs nobody. **Firmware that is structurally valid and then
hangs, crashes, or was built without the reset interface satisfies the bootrom, gets handed control,
and needs a finger on the button** — and that is the far commoner failure, because anything a
compiler produced passes the checksum. **Reported loudly per [§B6](../../CLAUDE.md): the RP2040's
famous unbrickability protects against the failure this project will not have.**

**Two specifics that make this sharper for a Rust firmware, not softer.** `embassy` ships **no
picotool reset class** — the ready-made one, `usbd-picotool-reset`, targets `usb-device` instead — so
`picotool -f` does not work against stock `embassy-usb` firmware until the trigger is wired by hand.
And every `embassy-rp` USB example **hardcodes `serial_number = Some("12345678")`**, which matters
because `/dev/serial/by-id/` names are built from it: two boards flashed from the example produce the
same symlink and, per `udev(7)`, *"the order of the devices (and which one of them owns the link) is
undefined."* Both are cheap to fix and neither is free by default. **The unconditional recovery path
is a wired SWD header and a second Pico as a probe**, which is a cable inside the enclosure that M9
would have to plan for.

**And one point in the thin client's favour that suits a printed enclosure**, verified per model
rather than assumed from the reputation: the **Futro S920** (9-pin header), the **Futro S740**
(20-pin USB 3 header), the **HP t630** (*"one USB 3.0 flash drive port on the system board"*, HP's
own words) and the **Dell Wyse 5070** (`INT_USB` on the system board) all have internal USB, so the
microcontroller can live inside the case instead of dangling from a port. **The HP t640 does not** —
established from silence across four HP documents plus a BIOS-menu difference rather than an explicit
denial, so treat it as a strong no rather than a certain one. **Do not generalise the HP dongle-port
reputation**; it does not survive model-by-model checking.

**The wrinkle that cuts the other way, and it must not be omitted: the Pi 5's advantage here is
asserted, not measured.** R6's own open gap is that **nobody has checked `/dev/leds0`'s byte order
against a real strip**, and there is no Pi 5 on this tailnet to check it on. If that overlay
disappoints, the timing-critical work lands on the owner on either path — the Pi 5 branch is
*expected* to be 150 lines over three file descriptors, and expected is not measured, which is the
same standard this note applies to everything else.

### 8.6 Everything rejected, and why, in one line each

| Candidate | Verdict |
| --- | --- |
| **N100 mini PC, new** | **Out on price before power.** Cheapest complete machine on amazon.de is €229.99; the cheapest Alder Lake-N anything is a €179.99 barebone, and Geizhals EU's floor is €164.34. |
| **N100 from AliExpress** | One listing at €109.69 VAT-inclusive looked plausible and **its SKU could not be verified** — the page is JS-rendered and served a bot challenge. AliExpress "from" prices routinely belong to a different CPU in the same listing; two neighbouring €90 "N100" listings resolve to a J1900 and a Haswell i5. **And the import maths changed on 2026-07-01**: the EU's €150 customs-duty exemption is gone, replaced by a **flat €3 per item** until 2028, with a handling fee still under negotiation. VAT is collected at checkout under IOSS; **whether the €3 is prepaid or billed on delivery could not be established.** Irrelevant on a €110 box, decisive on a €1.49 one. |
| **Fujitsu Futro S920** | 7.8 W at the wall for a weaker chip than the S740, and it has aged out of the German refurb channel. |
| **HP t620 / t630 / t640** | Worse idle at similar money, and not in current German refurb stock. |
| **Lenovo / Dell / HP Tiny and Micro** | 11–14 W measured at the wall — three to five times the Pi 5. Buy these for CPU headroom, never for a 24/7 box. |
| **Raspberry Pi 4** | **The worst square on the board.** It has no RP1, so `ws2812-pio` cannot load — and at **€105.90** for the 4 GB it is only €12.60 below a Pi 5 4 GB that keeps the overlay, while idling higher and running slower. Dominated in both directions at once. |
| **Raspberry Pi Zero 2 W** | **0.7 W idle is the best figure in this note**, it is **€18.90 and sold out**, and it is structurally insulated from the memory crisis — Raspberry Pi holds *"several years' inventory of the LPDDR2 memory"* these older boards use. It still has no RP1, so it is the fallback if the budget collapses, not the answer. |
| **Orange Pi, Radxa, Banana Pi** | **Not buyable in Germany** — absence confirmed at BerryBase, Welectron, Pollin, Botland and Antratek rather than merely unfound; the ones with a price are USD imports. Beyond that they need **two hand-written device-tree overlays**: Armbian ships no `rotary-encoder` overlay for any SoC, and no `ws2812` — and on RK3588 not even `spidev`. The one Armbian WS2812 driver that exists (H616/H618) bit-bangs GPIO with interrupts disabled and binds a node that exists only on a BigTreeTech board. |
| **An old Android phone** | No GPIO controller reachable from userspace, so it fails the requirement outright before any question of software support. |

### 8.7 The recommendation, and what it costs

**Buy a 2 GB Raspberry Pi 5 with a card, a supply and a cooler, from one shop, in one order.**

| What | Part | Price |
| --- | --- | --- |
| Board | Raspberry Pi 5, 2 GB | €68.90 |
| Storage | SanDisk High Endurance microSDXC 64 GB | €27.90 |
| Supply | Raspberry Pi 27 W USB-C power supply | €12.40 |
| Cooling | Raspberry Pi Active Cooler | €5.90 |
| | **Total** | **€115.10** |

All four from [BerryBase](https://www.berrybase.de), all shown in stock, all read on **2026-08-06**,
VAT included. Its shipping page contradicts itself on the same screen — *"For orders over €79, we
offer free shipping with DHL"* beside *"DHL Parcel €0.01 - €149.99: €4.95"* — so **assume €4.95 and
treat this as €120.05 rather than €115.10 if the ceiling is hard.** If it is, drop to the **1 GB
board at €46.90** and the same basket totals **€93.10** with room to spare.

**What this does not include, deliberately:**

- **The panel itself**, which is M8's and comes to about €17.64 at the same shop on the same day: a
  1.3" 128×64 I²C OLED **€6.90**, a rotary encoder with a push switch **€5.50**, a 50 cm 15-LED
  WS2812B strip **€4.70**, and the `SN74AHCT125N` level shifter §3 argues for at **€0.54**. Nothing
  in §1–§7 costed these; they are here so the number exists, not because M8 has started.
- **The enclosure**, which is printed and so costs filament rather than money (§6), and M9's.
- **The PCB**, which is M9's and which §5 argues should come after the thing works.

**Do not defer the cooler and the supply.** The instinct to leave them until later is worth pricing:
together they are **€18.30**, which is *less* than the €22.00 between the 1 GB and 2 GB boards. If
something in this basket has to wait, it should be memory, not power or heat. The supply matters more
than the cooler, because the Pi 5's documented alternative to its 5 A supply is *"5 V at 3 A (15 W)
with a 600 mA peripheral limit"* — a real constraint rather than a warning label. The cooler is the
genuinely optional one: Raspberry Pi's own position is that *"for normal use adding cooling is
entirely optional"* and *"no harm will come to your Raspberry Pi if it's left uncooled"*, with
passive cooling insufficient only for *"heavy loads that extend beyond 200 or 300 seconds"*, which an
idle daemon never produces. **What changes that is the printed case** — §6's *"the case should not be
covered"* is the same sentence read from the other end, and €5.90 is a cheap way to stop an enclosure
decision from becoming a throttling decision.

**Why the 2 GB and not the 1 GB:** the 2 GB is the variant actually measured at 2.4 W, it leaves room
for the *"tiny other things"*, and it fits. **Why the 1 GB is a real answer and not a consolation:**
it is the only Pi 5 whose price Raspberry Pi has explicitly held through three rounds of increases,
and on 2026-08-06 BerryBase had 100+ of them against a *limited availability* marker on the 2 GB.
If the memory market keeps moving, the 1 GB is the one that will still be there.

#### The runner-up, and what actually beat it

**A Fujitsu Futro S740 at €44.99 plus a Raspberry Pi Pico 2 at €5.50 — €50.49, less than half.**
The S740 (Celeron J4105, 4 GB DDR4, 8 GB SSD) was verified in stock at
[RAM-König](https://www.ram-koenig.de/refurbished-thin-clients/) on 2026-08-06, VAT included, with a
power supply and storage already in the box; the Wyse 5070 at €49.99 is the same argument. It has
**more RAM than the recommended Pi, ships complete, and costs €65 less.**

**It did not lose on price and it did not lose on power.** At 3–5 W against the Pi 5's ~2.7 W the gap
is about 2 W, and §8.4's arithmetic puts that at €7.40 a year against a €65 price difference — nine
years to repay. **Anyone arguing the Pi 5 on efficiency here is arguing from a number that does not
support them.**

**It lost on two things, and neither is "a microcontroller is hard".** §8.5 finds the encoder
collapses to the same evdev interface, the LED protocol has working prior art R6 already cites, and
the firmware stays in Rust — each smaller than §1 implied. **What does not shrink is that a firmware
image is a second deployable thing**, with its own toolchain, its own version, its own update path
and its own way of being out of step with the daemon, on a milestone whose entire stated thesis is
*one file to copy*. **And the recovery story is worse than the headline suggests**: `picotool -f`
needs the firmware that just died to still be running and cooperating, so the likely failure — a
valid image that hangs — puts a finger on a BOOTSEL button inside a sealed printed case. The
unconditional fix is a wired SWD header, which is a cable M9 would have to design around.

**And the €65 saved buys nothing that was asked for.** The requirement was a box under €120; the
recommended basket is under €120. A saving is a reason when the budget binds, and here it does not.

**What would flip this**, stated so that it can be checked rather than argued: if the 2 GB and 1 GB
boards both go out of stock or past €90, the Pi's price protection has failed and the Futro wins on
cost alone. If M8 is ever going to run on more than one box, the MCU path is portable and the RP1
path is not. And if `/dev/leds0`'s byte order turns out to be wrong or awkward when someone finally
checks it, the Pi 5's advantage was smaller than this note assumed throughout.

---

## Risks & unknowns

- **Nothing here ran on hardware.** No Pi 5 and no N100 is on this tailnet, which is why M7 is
  hardware-blocked; this note inherits that limit completely. Every claim is documentation, a
  primary-source drawing, or a public bug report.
- **Every price in §8 is a shop's asking price on 2026-08-06**, read off a product page, not a quote
  and not a receipt. The memory market moved three times in eight months; treat anything here older
  than a few weeks as a starting point for a fresh check rather than a number.
- **The 1 GB Pi 5's idle draw is inferred, not measured.** It carries the D0 stepping whose 2 GB
  sibling was measured at 2.4 W, and no measurement of the 1 GB board itself was found.
- **Second-hand marketplace prices are missing from this note.** `kleinanzeigen.de` and `ebay.de`
  refused every automated fetch, so the private-seller market — the one place a used Pi 5 would show
  up — is unmeasured here. The refurb-dealer prices quoted are shop listings, which are the ceiling
  of that market rather than its middle. `reichelt.de` returned 503 to everything, so a plausible
  stockist is absent from every price table above.
- **The cost of an NVMe drive on a Pi 5's idle draw is unmeasured, and the Pi cannot measure it** —
  §8.3. No same-system A/B is published, the circulating *"+1–2 W"* is an estimate rather than a
  reading, and `pmic_read_adc` cannot see the 5 V rail the drive sits on. **An inline USB-C meter is
  the instrument that would close this**, and nobody has put one on it.
- **A cheapest price on a comparison site is not a buyable price.** Several NVMe figures that look
  best on `geizhals.de` resolve to a single eBay or marketplace seller rather than a shop; the drives
  quoted above were traced to a named merchant. This is the trap that makes a storage budget look
  €20 smaller than it is.
- **The thin-client idle figures are weaker than the Pi's.** The Futro S740's flattering 2.9 W is one
  hobbyist's meter, contradicted by the same author's later ~5 W; the parkytowers Wyse and HP numbers
  do not state whether they are wall or board level, and that page labels the t640's as *claimed*.
  §8.4's conclusion survives this because it turns on the gap being small either way, not on which
  figure is right.
- **The HP t640's lack of an internal USB port is established from silence**, across four HP
  documents and a BIOS-menu difference, rather than from a vendor saying so.
- **R6's own gap is still open and is now the first thing M8 should close**: nobody has checked
  `/dev/leds0`'s byte order against a real strip. `ws2812-pio` is also *"up to 4 supported, assuming
  nothing else is using PIO"* — this design uses one.
- **The level-shifting constraint is derived from the WS2812 datasheet threshold, not measured
  here.** It predicts an intermittent fault, which is by nature the kind of prediction a single
  successful breadboard test cannot refute.
- **The material temperature figures are supplier claims**, not measurements, and vary by grade.
- **The mechanical drawings disclaim themselves** — see §6. They are correct enough to model
  against and not to manufacture against.
- **The N100 branch of §1 is reasoned, not researched.** If Q15 moves that way, the MCU path needs a
  note of its own; nothing here costs firmware, the serial protocol or the flashing story.

---

## Sources

*All retrieved 2026-08-05 unless stated.*

**Primary — Raspberry Pi**
- [Raspberry Pi 5 product brief](https://pip-assets.raspberrypi.com/categories/892-raspberry-pi-5/documents/RP-008348-DS-6-raspberry-pi-5-product-brief.pdf)
  · published **April 2026** · physical specification drawing, operating temperature, warnings
- [Raspberry Pi Active Cooler product brief](https://pip-assets.raspberrypi.com/categories/993-raspberry-pi-active-cooler/documents/RP-008188-DS-2-raspberry-pi-active-cooler-product-brief.pdf)
  · physical specification drawing, warnings
- [HAT+ specification](https://datasheets.raspberrypi.com/hat/hat-plus-specification.pdf) and
  [raspberrypi/hats](https://github.com/raspberrypi/hats) · ID EEPROM requirement, ID_SD/ID_SC rules
- [`overlays/README`, `raspberrypi/linux` `rpi-6.12.y`](https://github.com/raspberrypi/linux/blob/rpi-6.12.y/arch/arm/boot/dts/overlays/README)
  · `ws2812-pio` and `rotary-encoder` entries quoted verbatim in §2, from the file retrieved at 6,202 lines

**Level shifting**
- [Adafruit — level shifting NeoPixels](https://learn.adafruit.com/neopixel-levelshifter/shifting-levels) · 74AHCT125 / 74AHCT245
- [Hackaday — cheating at 5 V WS2812 control with a 3.3 V data line](https://hackaday.com/2017/01/20/cheating-at-5v-ws2812-control-to-use-a-3-3v-data-line/) · the supply-drop alternative
- [Raspberry Pi forums — WS2812 with or without a level shifter](https://forums.raspberrypi.com/viewtopic.php?t=258577)

**The udev finding**
- [LibreELEC forum — *ws2812-pio-rp1 kernel driver seems not functional on RPi5*](https://forum.libreelec.tv/thread/30075-ws2812-pio-rp1-kernel-driver-seems-not-functional-on-rpi5/)
  · reported against kernels 6.12.40 and 6.12.55, resolved as a `SUBSYSTEM=="*-pio"` udev rule

**Microcontroller comparison**
- [Predictable Designs — ESP32 vs RP2350](https://predictabledesigns.com/rp2350-vs-esp32/)
- [HowToGeek — ESP32 alternatives](https://www.howtogeek.com/esp32-alternatives-for-your-next-project-and-why-you-should-use-them/)

**Fabrication and materials** *(supplier figures, not measurements)*
- [JLCPCB prototype pricing](https://jlcpcb.com/features/pcb-prototype) and
  [assembly](https://jlcpcb.com/pcb-assembly) · NRE and stencil per design
- [Accu — heat-set insert pilot-hole charts](https://accu-components.com/us/p/488-threaded-insert-hole-size-charts-for-3d-printing-pla-petg-resin)
  · M3 pilot 4.0–4.2 mm
- [Markforged — using heat-set inserts](https://markforged.com/resources/blog/heat-set-inserts) · relief below blind holes
- [Filament choice for electronics enclosures](https://www.goodprints3d.com/blogs/3d/best-filament-for-3d-printed-electronics-enclosures-pla-petg-asa-or-abs)
  and [3D Solved — is PLA heat resistant?](https://3dsolved.com/is-pla-heat-resistant-abs-asa-petg-and-more/)

**§8 — prices, all fetched 2026-08-06 and all stale by the time you read them**
- [BerryBase](https://www.berrybase.de) · Pi 5 1/2/4/8/16 GB product pages, 27 W and 5.1 V/3 A
  supplies, Active Cooler, SanDisk High/Max Endurance cards, Raspberry Pi A2 cards, M.2 HAT,
  Pimoroni NVMe Base, Pico 2, OLED-13B-H, rotary encoder, WS2812B strip, `SN74AHCT125N` ·
  prices incl. VAT, stock as displayed
- [Welectron](https://www.welectron.com) · Pi 5 1/4/8/16 GB · the independent check on BerryBase
- [RAM-König](https://www.ram-koenig.de/refurbished-thin-clients/) · Futro S740, S7010, S540 and
  Wyse 5070 refurb listings, incl. VAT · read off the live category page
- [Alternate](https://www.alternate.de), [Amazon.de](https://www.amazon.de) and
  [geizhals.de](https://geizhals.de) · NVMe drives in 2230, 2242 and 2280, the Digitus and UGREEN
  enclosures, and the Netac USB SSD · **offer lists traced to a named merchant**, because several
  headline comparison prices are single marketplace sellers
- [Raspberry Pi M.2 HAT+ documentation](https://www.raspberrypi.com/documentation/accessories/m2-hat-plus.html)
  · 2230 and 2242 only, the 16 mm stacking header that clears the Active Cooler, the 3 A limit, and
  the verbatim *"not certified for Gen 3.0 speeds"* warning

**§8 — the memory market, from Raspberry Pi's own announcements**
- [1GB Raspberry Pi 5 at $45, and memory-driven price rises](https://www.raspberrypi.com/news/1gb-raspberry-pi-5-now-available-at-45-and-memory-driven-price-rises/)
  · 2025-12-01 · the 1 GB SKU, the BCM2712 D0 stepping, and the first price table
- [More memory-driven price rises](https://www.raspberrypi.com/news/more-memory-driven-price-rises/)
  · 2026-02-02 · the LPDDR4 / AI-fab-capacity attribution
- [A new 3GB Raspberry Pi 4, and more memory-driven price increases](https://www.raspberrypi.com/news/a-new-3gb-raspberry-pi-4-for-83-75-and-more-memory-driven-price-increases/)
  · 2026-04-01 · the third round, and the sentence holding 1 GB and 2 GB *"between $35 and $65"*

**§8 — power, measured**
- [`jfikar/RPi5-power`](https://github.com/jfikar/RPi5-power) and
  [Raspberry Pi forums t=368054](https://forums.raspberrypi.com/viewtopic.php?t=368054) · the PMIC
  does not see the USB, HAT or NVMe branches; a Raspberry Pi engineer on APST exit latencies and why
  not to reach for `pcie_aspm=off`
- [Jeff Geerling — the 2 GB Pi 5's smaller die and its idle power](https://www.jeffgeerling.com/blog/2024/new-2gb-pi-5-has-33-smaller-die-30-idle-power-savings/)
  · D0 2.4 W against C1 3.3 W / 3.2 W, and the delidded die measurements behind it
- [raspberry.tips — Raspberry Pi power consumption, all models](https://raspberry.tips/en/raspberrypi-tutorials/raspberry-pi-power-consumption-update-2026-all-models-compared)
  · updated 2026-07-28 · at the wall, PSU losses included
- [weisser-zwerg.dev](https://weisser-zwerg.dev/posts/dell-wyse-fujitsu-futro/) · Futro S920 at the
  wall · [parkytowers.me.uk](https://www.parkytowers.me.uk/thin/) · Wyse and HP thin-client figures,
  **method not stated, and the t640's are labelled *claimed* on the source's own page**
- [ServeTheHome](https://www.servethehome.com/lenovo-thinkcentre-m710q-tiny-guide-and-ce-review/3/) ·
  Lenovo Tiny at the wall · [CNX Software](https://www.cnx-software.com/) · N100 mini-PC idle
- [BDEW electricity price analysis](https://www.bdew.de/service/daten-und-grafiken/bdew-strompreisanalyse/)
  · 37.0 ct/kWh, April 2026 · the multiplier behind §8.4's arithmetic

**§8 — cooling, supply and the MCU path**
- [Raspberry Pi — heating and cooling Raspberry Pi 5](https://www.raspberrypi.com/news/heating-and-cooling-raspberry-pi-5/)
  · 2023-10-04 · throttle at 80 °C and 85 °C; *"for normal use adding cooling is entirely optional"*
- [Raspberry Pi documentation — computers](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html)
  · *"5 V at 5 A (25W); or 5 V at 3 A (15 W) with a 600 mA peripheral limit"*
- [Linux kernel — HID introduction](https://docs.kernel.org/hid/hidintro.html) · HID reports become
  evdev events, one `/dev/input/event*` per Application Collection
- [`raspberrypi/picotool`](https://github.com/raspberrypi/picotool) · `-f` forcing a running device
  into BOOTSEL over USB, and `load -f -x`
- [scruss — Raspberry Pi vs used thin client](https://scruss.com/blog/2025/10/01/raspberry-pi-vs-used-thin-client/)
  · 2025-10-01 · no 40-pin header on a thin client, and the Pico-over-USB workaround
- [USB-IF defined class codes](https://www.usb.org/defined-class-codes) · no class carries pixel
  data · HID Usage Tables §26, *Lighting And Illumination* page 0x59 · the `LampArray` standard
  Linux does not implement
- [`torvalds/linux`](https://github.com/torvalds/linux) `drivers/hid/hid-generic.c`,
  `drivers/hid/hid-input.c`, `drivers/leds/rgb/Makefile` · the HID fallback bind, the consumer and
  wheel mappings, and the absence of any `ws2812` LED-class driver
- [`raspberrypi/linux`](https://github.com/raspberrypi/linux) `ws2812-pio-overlay.dts` ·
  `compatible = "brcm,bcm2712"` — the overlay cannot load on a Pi 4 or Zero 2 W
- [`jgarff/rpi_ws281x`](https://github.com/jgarff/rpi_ws281x) · the pre-Pi-5 fallback, its audio
  conflict and its `core_freq` pinning
- Fujitsu Futro S920 and S740 data sheets; [HP t630 troubleshooting guide](https://support.hp.com/)
  c05193361 and t640 user guide c06540263; Dell Wyse 5070 user guide · internal USB, per model
- [European Commission — customs](https://taxation-customs.ec.europa.eu/) · the €150 duty exemption
  removed and a €3-per-item duty from 2026-07-01

**Yantra internal** — [`CLAUDE.md`](../../CLAUDE.md) §B2 and §B6;
[`tracker.md`](../../tracker.md) milestones M7, M8 and M9, rows Y-142…Y-150 and Y-152, and
question Q15; [R6](06-runtime-feasibility.md) §*Pi 5 hardware I/O*, its `HyperSerialPico` citation
and I-19; [`brainstorm.md`](../brainstorm.md); [ADR-0004](../adr/0004-rust-for-the-daemon.md) and its
2026-08-02 amendment; [`docs/development.md`](../development.md)'s `appliance-size` figures;
[`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md).
