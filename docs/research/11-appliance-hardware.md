# 11 — The appliance's hardware: does the panel need a microcontroller, a PCB, or only a printer?

Access date: **2026-08-05**. Written for [Y-152](../../tracker.md), against M8 and M9, and extending
[R6](06-runtime-feasibility.md).

> **Scope.** Three questions the owner asked on 2026-08-05, in the order in which they gate each
> other: does the panel need a microcontroller — an ESP32 or anything else; does it need a custom
> PCB; and what of the enclosure can be 3D printed. This note does **not** design the panel process
> or its socket protocol — R6 settled that shape and M8 owns it — and it does not choose components
> for the wish list in [`brainstorm.md`](../brainstorm.md), which is deliberately larger than M8.

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

## Risks & unknowns

- **Nothing here ran on hardware.** No Pi 5 and no N100 is on this tailnet, which is why M7 is
  hardware-blocked; this note inherits that limit completely. Every claim is documentation, a
  primary-source drawing, or a public bug report.
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

**Yantra internal** — [`CLAUDE.md`](../../CLAUDE.md) §B2 and §B6;
[`tracker.md`](../../tracker.md) milestones M7, M8 and M9, rows Y-142…Y-150 and Y-152, and
question Q15; [R6](06-runtime-feasibility.md) §*Pi 5 hardware I/O* and I-19;
[`brainstorm.md`](../brainstorm.md).
