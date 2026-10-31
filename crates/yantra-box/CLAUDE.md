# yantra-box — working notes

This crate writes a Yantra box installer to a USB stick. It asks questions, then runs
[`box/build.sh`](../../box/build.sh) and [`box/flash.sh`](../../box/flash.sh), which it embeds.

Scoped to this crate; the root [`CLAUDE.md`](../../CLAUDE.md) still binds.

- It orchestrates `podman`, `xorriso` and `dd`. It does not reimplement them (§B2).
- It offers only whole USB disks. `flash.sh` checks again and asks for a typed `yes`.
- It never reads the password or the auth key. `build.sh` prompts for them, hidden.
- It deletes the ISO after a flash, because the ISO holds secrets.
