//! What a machine can measure about itself — the seven fields of
//! [`Heartbeat`], and nothing a daemon would have to tell it.
//!
//! Split the way [ADR-0013] §1 splits it: [`Fixed`] is measured **once, at
//! agent start**, and [`beat`] is measured every 10 s. That is the whole reason
//! the probes stay cheap — `nvidia-smi` alone costs 1.25 s on this fleet.
//!
//! **Every reader fails toward the value that loses a placement.** A failed
//! load-average read reports 100, not 0, because `cpu_busy_pct: 0` is a
//! *perfect* CPU-idle score and a broken reader would otherwise win every
//! placement it entered.
//!
//! The parsers take `&str` and the power reader takes a directory, so the
//! platform half of every probe is one line and the half that can be wrong is
//! exercised against recorded fixtures from both fleet machines. That is not a
//! substitute for §B3 — it is the only way to reach two states this fleet
//! cannot produce: a desktop with no battery, and a machine that is unplugged.
//! Both platforms' parsers compile everywhere, which is what the `dead_code`
//! exemptions buy: Linux CI runs the macOS ones, and Linux CI is all there is.
//!
//! [ADR-0013]: ../../../docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md

use std::path::{Path, PathBuf};
use std::process::Command;

use time::OffsetDateTime;
use yantra_core::agent::CANDIDATES;
use yantra_core::heartbeat::{Heartbeat, Power};

// Q4 is open by choice: Windows has no `/proc`, no `sysctl`, no `pmset` and no
// load average, and answering it here would close a question the owner left open.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
compile_error!("the probes are Linux and macOS only; Windows is Q4 and is not decided");

/// The two fields ADR-0013 §1 measures once and transmits every beat.
#[derive(Debug, Clone)]
pub struct Fixed {
    arch: &'static str,
    labels: Vec<String>,
}

impl Fixed {
    pub fn measure() -> Self {
        Self {
            // `rustc`'s spelling, not `uname -m`'s: the same MacBook is `arm64`
            // to `uname` and `aarch64` to `rustc`, and a compile-time constant
            // costs no syscall and answers uniformly on every platform. M5's
            // hard filter 3 must compare `requires.arch` against this spelling.
            arch: std::env::consts::ARCH,
            labels: labels(),
        }
    }
}

/// One beat's worth of the machine.
pub fn beat(fixed: &Fixed) -> Heartbeat {
    let now = OffsetDateTime::now_utc();
    Heartbeat {
        // Whole seconds, which is ADR-0013 §1's example and Y-104's test vector.
        // Nine digits of precision would be consumed by nothing: the beat is
        // 10 s, the staleness threshold 30 s, and the field's job is to spot a
        // clock that is wrong by minutes, not a delivery late by milliseconds.
        sent_at: now.replace_nanosecond(0).unwrap_or(now),
        arch: fixed.arch.to_owned(),
        labels: fixed.labels.clone(),
        free_ram_mb: free_ram_mb(),
        free_disk_mb: free_disk_mb(),
        cpu_busy_pct: cpu_busy_pct(),
        power: power(),
    }
}

fn stdout_of(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .map(|s| s.trim().to_owned())
        .ok()
}

// ---- labels ----------------------------------------------------------------

/// Derived from probes, never configured: a machine tagged `gpu` whose driver
/// broke otherwise passes hard filter 4 forever (ADR-0013 §1).
fn labels() -> Vec<String> {
    let mut labels = Vec::new();
    // `gpu` means *a working NVIDIA driver*, so the binary has to run and not
    // merely exist. Every fleet machine has some GPU; only this claim can
    // change a placement.
    if find("nvidia-smi").is_some_and(|p| {
        Command::new(p)
            .output()
            .is_ok_and(|out| out.status.success())
    }) {
        labels.push("gpu".to_owned());
    }
    for tool in ["docker", "podman", "tmux"] {
        if find(tool).is_some() {
            labels.push(tool.to_owned());
        }
    }
    labels
}

/// `PATH` first, then [`CANDIDATES`] — I-34's list, shared rather than copied,
/// because a fleet where `claude` is found and `docker` is not, because two
/// lists drifted, is the bug I-34 exists to name.
///
/// `PATH` alone is not enough on macOS: `launchctl getenv PATH` is empty, so a
/// LaunchAgent inherits `/usr/bin:/bin:/usr/sbin:/sbin` and sees neither Docker
/// at `/usr/local/bin` nor Homebrew tmux at `/opt/homebrew/bin`. The measured
/// result is `labels: []` on a Mac that has both — a hard-filter-4 rejection
/// that is permanent and silent.
fn find(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(
            CANDIDATES
                .iter()
                .map(|d| PathBuf::from(d.replace("$HOME", &home))),
        )
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

// ---- free_ram_mb -----------------------------------------------------------

#[cfg(target_os = "linux")]
fn free_ram_mb() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|meminfo| mem_available_mb(&meminfo))
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn free_ram_mb() -> u64 {
    stdout_of("vm_stat", &[])
        .and_then(|vm_stat| vm_stat_free_mb(&vm_stat))
        .unwrap_or(0)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn mem_available_mb(meminfo: &str) -> Option<u64> {
    let line = meminfo
        .lines()
        .find_map(|l| l.strip_prefix("MemAvailable:"))?;
    Some(line.split_whitespace().next()?.parse::<u64>().ok()? / 1024)
}

/// `vm_stat`, not `memory_pressure`: taken the same instant on the same Mac the
/// two disagree by slightly more than 2× (5,386 MB against 10,977 MB), and this
/// is the conservative one, a count rather than a rounded percentage, and the
/// closer analogue of Linux's `MemAvailable`.
///
/// The page size comes from `vm_stat`'s own header rather than from
/// `sysctl -n hw.pagesize`, so it cannot disagree with the counts printed under it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn vm_stat_free_mb(vm_stat: &str) -> Option<u64> {
    let page_bytes = vm_stat
        .lines()
        .next()?
        .split_once("page size of ")?
        .1
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    let mut pages = 0u64;
    for key in ["Pages free:", "Pages inactive:", "Pages speculative:"] {
        let line = vm_stat.lines().find_map(|l| l.strip_prefix(key))?;
        pages += line.trim().trim_end_matches('.').parse::<u64>().ok()?;
    }
    Some(pages * page_bytes / 1024 / 1024)
}

// ---- free_disk_mb ----------------------------------------------------------

/// Root filesystem only (ADR-0013 §1), and `-P` because POSIX mode guarantees
/// one line per filesystem — a long device name wraps the row otherwise and the
/// field index lands in the wrong column.
///
/// On macOS `/` is the sealed system snapshot (`disk3s1s1`, 24 % used) and every
/// repository lives on `disk3s5` (92 %). `Available` is nevertheless right,
/// because APFS shares free space across the container — that is luck rather
/// than design, and `Used`, `Capacity` and `1024-blocks` from that same line are
/// wrong by a factor of four.
fn free_disk_mb() -> u64 {
    stdout_of("df", &["-Pk", "/"])
        .and_then(|df| df_available_mb(&df))
        .unwrap_or(0)
}

fn df_available_mb(df: &str) -> Option<u64> {
    let available = df.lines().nth(1)?.split_whitespace().nth(3)?;
    Some(available.parse::<u64>().ok()? / 1024)
}

// ---- cpu_busy_pct ----------------------------------------------------------

#[cfg(target_os = "linux")]
fn cpu_busy_pct() -> u8 {
    busy_pct(
        std::fs::read_to_string("/proc/loadavg").ok().as_deref(),
        std::thread::available_parallelism().ok().map(|n| n.get()),
    )
}

#[cfg(target_os = "macos")]
fn cpu_busy_pct() -> u8 {
    busy_pct(
        stdout_of("sysctl", &["-n", "vm.loadavg"]).as_deref(),
        std::thread::available_parallelism().ok().map(|n| n.get()),
    )
}

/// `min(load1/ncpu, 1) × 100`, and 100 whenever either reading is missing.
fn busy_pct(load_average: Option<&str>, ncpu: Option<usize>) -> u8 {
    let (Some(load1), Some(ncpu)) = (load_average.and_then(load1), ncpu) else {
        return 100;
    };
    ((load1 / ncpu as f64).min(1.0) * 100.0).round() as u8
}

/// The first field that parses as a number, because macOS wraps its load average
/// in braces — `{ 2.13 2.42 2.73 }` — so `load1` is the *second* whitespace field
/// there and the first on Linux. A `/proc/loadavg`-shaped parser reads `{`,
/// yields 0, and ranks every Mac as a perfectly idle machine forever.
fn load1(load_average: &str) -> Option<f64> {
    load_average
        .split_whitespace()
        .find_map(|field| field.parse::<f64>().ok())
}

// ---- power -----------------------------------------------------------------

#[cfg(target_os = "linux")]
fn power() -> Power {
    sysfs_power(Path::new("/sys/class/power_supply"))
}

#[cfg(target_os = "macos")]
fn power() -> Power {
    stdout_of("pmset", &["-g", "batt"]).map_or(Power::Ac, |batt| pmset_power(&batt))
}

/// ADR-0013 §2's two-reading rule, and **the only place the `Battery` variant is
/// constructed**. The type cannot enforce it — `Battery { percent }` is
/// constructible from a single reading and no serde representation prevents it
/// — so this function is the enforcement, and a second construction site would
/// silently repeal it.
///
/// The ADR's *"from that same device"* is sysfs-shaped and matches neither
/// platform: Linux splits the mains state onto `AC0` and the percentage onto
/// `BAT0`, and macOS gives a system line plus a device line. The rule survives
/// the phrasing — mains-offline **and** a percentage, from whatever the
/// platform's mains and battery sources are, and everything else is `Ac`.
fn power_from(mains_offline: bool, percent: Option<u8>) -> Power {
    match (mains_offline, percent) {
        (true, Some(percent)) => Power::Battery { percent },
        _ => Power::Ac,
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn sysfs_power(power_supply: &Path) -> Power {
    let Ok(entries) = std::fs::read_dir(power_supply) else {
        return Power::Ac;
    };
    let mut mains_online = None;
    let mut percent = None;
    for device in entries.flatten().map(|e| e.path()) {
        // A `scope` of `Device` is a peripheral's own battery — a wireless mouse,
        // commonest on exactly the desktops I-9 is about. No `scope` file means
        // `System`; this fleet's `BAT0` has none.
        if read_trimmed(&device.join("scope")).as_deref() == Some("Device") {
            continue;
        }
        match read_trimmed(&device.join("type")).as_deref() {
            // Filter on `type`, never a glob over `*/online`: this fleet's laptop
            // carries a third device, `ucsi-source-psy-USBC000:001` (`type=USB`),
            // reporting `online: 0` while the machine is on mains.
            Some("Mains") => {
                let online = read_trimmed(&device.join("online")).as_deref() == Some("1");
                mains_online = Some(mains_online.unwrap_or(false) || online);
            }
            // `capacity`, never `status`: `status` reads `Not charging` at 100 %
            // on AC on this machine right now, which is I-9's trap sitting live.
            Some("Battery") => {
                percent = percent.or_else(|| read_trimmed(&device.join("capacity"))?.parse().ok());
            }
            _ => {}
        }
    }
    power_from(mains_online == Some(false), percent)
}

/// The mains state is `pmset`'s first line and the percentage is on the device
/// line. The status word on that device line — `charged`, `discharging` — is
/// never read: inferring AC from a battery's status string is the trap I-9 was
/// measured on.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pmset_power(batt: &str) -> Power {
    let mains_offline = batt
        .lines()
        .next()
        .is_some_and(|line| line.contains("'Battery Power'"));
    let percent = batt.split_once('%').and_then(|(before, _)| {
        before
            .rsplit(|c: char| !c.is_ascii_digit())
            .next()?
            .parse()
            .ok()
    });
    power_from(mains_offline, percent)
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take a daemon down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    // Verbatim from both fleet machines on 2026-08-02, sanitised. The battery
    // fixture is the one output neither machine can produce: both were on mains
    // throughout, so its percentage and `discharging` are hand-written around a
    // real line's shape.
    const LINUX_LOADAVG: &str = "1.27 1.49 0.95 3/1407 1992325\n";
    const MACOS_LOADAVG: &str = "{ 2.13 2.42 2.73 }\n";
    const LINUX_MEMINFO: &str = "MemTotal:       15709160 kB\nMemFree:         1043912 kB\nMemAvailable:    7640584 kB\nBuffers:          228696 kB\n";
    const MACOS_VM_STAT: &str = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                    10364.\nPages active:                                 343725.\nPages inactive:                               328310.\nPages speculative:                             14528.\nPages throttled:                                   0.\n";
    const LINUX_DF: &str = "Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/nvme0n1p6   425438208 57011612 366934244      14% /\n";
    const MACOS_DF_ROOT: &str = "Filesystem     1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s1s1   482797652  12276800  40211536    24%    /\n";
    const MACOS_DF_DATA: &str = "Filesystem   1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s5   482797652 411806576  40211536    92%    /System/Volumes/Data\n";
    const PMSET_AC: &str = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=<id>)\t100%; charged; 0:00 remaining present: true\n";
    const PMSET_BATTERY: &str = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=<id>)\t76%; discharging; 2:41 remaining present: true\n";

    /// A directory that looks like `/sys/class/power_supply`, because the two
    /// states this fleet cannot produce — a desktop with no battery, and a
    /// machine that is unplugged — have no other test.
    struct FakeSysfs(PathBuf);

    impl FakeSysfs {
        fn new(name: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("yantra-probes-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("a temporary directory");
            Self(root)
        }

        fn device(&self, name: &str, files: &[(&str, &str)]) -> &Self {
            let dir = self.0.join(name);
            std::fs::create_dir_all(&dir).expect("a device directory");
            for (file, contents) in files {
                std::fs::write(dir.join(file), format!("{contents}\n")).expect("a sysfs file");
            }
            self
        }

        fn power(&self) -> Power {
            sysfs_power(&self.0)
        }
    }

    impl Drop for FakeSysfs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// `cachyos-g14` as it stands: plugged in, full, and carrying a USB-C PD
    /// port that reports `online: 0` next to a battery whose `status` says
    /// `Not charging`. Two ways to get this wrong, both live.
    fn plugged_in_laptop(name: &str) -> FakeSysfs {
        let fake = FakeSysfs::new(name);
        fake.device("AC0", &[("type", "Mains"), ("online", "1")])
            .device(
                "BAT0",
                &[
                    ("type", "Battery"),
                    ("status", "Not charging"),
                    ("capacity", "100"),
                    ("present", "1"),
                ],
            )
            .device(
                "ucsi-source-psy-USBC000:001",
                &[("type", "USB"), ("online", "0"), ("scope", "System")],
            );
        fake
    }

    #[test]
    fn the_braced_macos_load_average_yields_load1_and_not_zero() {
        assert_eq!(load1(LINUX_LOADAVG), Some(1.27));
        assert_eq!(load1(MACOS_LOADAVG), Some(2.13));
    }

    /// ADR-0013 §1's formula against the fixtures' own worked arithmetic:
    /// 1.27/12 → 11, and 2.13/8 → 27.
    #[test]
    fn cpu_busy_is_load1_over_ncpu_clamped_to_one() {
        assert_eq!(busy_pct(Some(LINUX_LOADAVG), Some(12)), 11);
        assert_eq!(busy_pct(Some(MACOS_LOADAVG), Some(8)), 27);
        assert_eq!(busy_pct(Some("48.00 40.00 30.00"), Some(12)), 100);
    }

    /// The failure direction that matters most: 0 is a *perfect* CPU-idle score,
    /// so an unreadable load average must look like a pegged machine.
    #[test]
    fn an_unreadable_load_average_reports_a_busy_machine() {
        assert_eq!(busy_pct(None, Some(12)), 100);
        assert_eq!(busy_pct(Some(""), Some(12)), 100);
        assert_eq!(busy_pct(Some("{ }"), Some(12)), 100);
        assert_eq!(busy_pct(Some(LINUX_LOADAVG), None), 100);
    }

    #[test]
    fn free_ram_is_mem_available_on_linux() {
        assert_eq!(mem_available_mb(LINUX_MEMINFO), Some(7461));
        assert_eq!(mem_available_mb("MemTotal: 15709160 kB\n"), None);
    }

    /// The conservative half of the 2× disagreement: `memory_pressure` called
    /// the same instant 68 % free, which is 11,141 MB.
    #[test]
    fn free_ram_is_vm_stats_count_on_macos_and_not_memory_pressures_percentage() {
        assert_eq!(vm_stat_free_mb(MACOS_VM_STAT), Some(5518));
        assert_eq!(vm_stat_free_mb("Pages free: 10364.\n"), None);
    }

    #[test]
    fn free_disk_is_dfs_available_column() {
        assert_eq!(df_available_mb(LINUX_DF), Some(358334));
        assert_eq!(df_available_mb(MACOS_DF_ROOT), Some(39269));
        assert_eq!(
            df_available_mb("Filesystem 1024-blocks Used Available\n"),
            None
        );
    }

    /// The APFS luck, pinned: `/` and the volume holding every repository are
    /// different devices reporting 24 % and 92 % used, and the *only* column
    /// that agrees is the one ADR-0013 asks for.
    #[test]
    fn the_macos_system_snapshot_and_the_data_volume_share_free_space() {
        assert_eq!(
            df_available_mb(MACOS_DF_ROOT),
            df_available_mb(MACOS_DF_DATA)
        );
    }

    #[test]
    fn a_plugged_in_laptop_is_ac_despite_a_usb_port_reporting_offline() {
        assert_eq!(plugged_in_laptop("plugged").power(), Power::Ac);
    }

    /// The first `Power::Battery` this project has produced. Both fleet machines
    /// were on mains for every reading ever taken, so unplugging `AC0` in a fake
    /// tree is the only way to reach the variant.
    #[test]
    fn an_unplugged_laptop_is_a_battery_at_its_capacity() {
        let fake = plugged_in_laptop("unplugged");
        fake.device("AC0", &[("type", "Mains"), ("online", "0")]);
        assert_eq!(fake.power(), Power::Battery { percent: 100 });
    }

    /// I-9's founding case, which this fleet cannot supply — it has no desktop.
    #[test]
    fn a_machine_with_no_power_supply_devices_at_all_is_ac() {
        assert_eq!(FakeSysfs::new("desktop").power(), Power::Ac);
        assert_eq!(
            sysfs_power(Path::new("/nonexistent/power_supply")),
            Power::Ac
        );
    }

    /// Every way to hold one of the two readings and not the other.
    #[test]
    fn one_reading_is_never_enough_for_a_battery() {
        let no_mains_entry = FakeSysfs::new("no-mains");
        no_mains_entry.device("BAT0", &[("type", "Battery"), ("capacity", "42")]);
        assert_eq!(no_mains_entry.power(), Power::Ac);

        let no_percentage = FakeSysfs::new("no-percentage");
        no_percentage
            .device("AC0", &[("type", "Mains"), ("online", "0")])
            .device("BAT0", &[("type", "Battery"), ("status", "Discharging")]);
        assert_eq!(no_percentage.power(), Power::Ac);

        // A USB-C source is not a mains entry, however loudly it reports offline.
        let usb_only = FakeSysfs::new("usb-only");
        usb_only
            .device(
                "ucsi-source-psy-USBC000:001",
                &[("type", "USB"), ("online", "0")],
            )
            .device("BAT0", &[("type", "Battery"), ("capacity", "42")]);
        assert_eq!(usb_only.power(), Power::Ac);

        // A wireless mouse at 7 % is not this machine's power state.
        let peripheral = FakeSysfs::new("peripheral");
        peripheral
            .device("AC0", &[("type", "Mains"), ("online", "0")])
            .device(
                "hid-mouse-battery",
                &[("type", "Battery"), ("capacity", "7"), ("scope", "Device")],
            );
        assert_eq!(peripheral.power(), Power::Ac);
    }

    #[test]
    fn pmset_on_mains_is_ac_however_its_status_word_reads() {
        assert_eq!(pmset_power(PMSET_AC), Power::Ac);
        // A desktop Mac prints the first line and no device line at all.
        assert_eq!(pmset_power("Now drawing from 'AC Power'\n"), Power::Ac);
        assert_eq!(pmset_power(""), Power::Ac);
    }

    #[test]
    fn pmset_off_mains_is_a_battery_at_its_percentage() {
        assert_eq!(pmset_power(PMSET_BATTERY), Power::Battery { percent: 76 });
    }

    /// Y-104 left the two-reading rule to the probe and nothing downstream can
    /// catch a violation, so the rule is only real while `power_from` is the one
    /// place the variant is named.
    #[test]
    fn battery_has_exactly_one_construction_site() {
        let source = include_str!("probes.rs");
        let outside_tests = source.split("#[cfg(test)]").next().unwrap_or(source);
        assert_eq!(
            outside_tests.matches("Power::Battery").count(),
            1,
            "`power_from` must stay the only constructor of `Power::Battery`"
        );
    }

    /// §3.5's macOS finding is only fixed while the shared list covers what a
    /// LaunchAgent's `PATH` does not.
    #[test]
    fn the_shared_candidate_list_holds_the_paths_path_misses() {
        for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
            assert!(
                CANDIDATES.contains(&dir),
                "{dir} is where this fleet's tmux and docker are"
            );
        }
    }

    /// The fixtures above are recordings; this runs the probes against the
    /// machine executing the test, on both of which it is part of the evidence.
    #[test]
    fn a_beat_measures_the_machine_it_runs_on() {
        let beat = beat(&Fixed::measure());
        assert!(
            matches!(beat.arch.as_str(), "x86_64" | "aarch64"),
            "arch is rustc's spelling, never `uname -m`'s `arm64`: {}",
            beat.arch
        );
        assert!(beat.free_ram_mb > 0, "free RAM must parse");
        assert!(beat.free_disk_mb > 0, "free disk must parse");
        // Zero would mean the load average was misread — the macOS brace bug.
        assert!(
            beat.cpu_busy_pct > 0,
            "a machine running its own tests is not idle"
        );
        assert_eq!(beat.sent_at.nanosecond(), 0, "`sent_at` is whole seconds");
    }
}
