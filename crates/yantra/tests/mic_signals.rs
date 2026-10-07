//! `yantra mic`'s order and its Ctrl-C, on this host alone (Y-442): the built
//! binary, with stand-ins for `ssh` and `pw-record` on its `PATH`. What they
//! prove is the verb's own sequence, not the transport, so no podman.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

struct Laptop {
    dir: PathBuf,
}

impl Laptop {
    /// `ssh` records its pid, then runs `ssh`; `pw-record` is there only when
    /// asked for, and it records nothing.
    fn new(label: &str, ssh: &str, recorder: bool) -> Self {
        let dir = std::env::temp_dir().join(format!("yantra-mic-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["bin", "home/.ssh", "run"] {
            std::fs::create_dir_all(dir.join(sub)).expect("a dir");
        }
        std::fs::set_permissions(dir.join("run"), std::fs::Permissions::from_mode(0o700))
            .expect("a private runtime dir");
        std::fs::write(
            dir.join("home/.ssh/config"),
            "Host fixture\n  HostName 127.0.0.1\n",
        )
        .expect("an ssh config");
        let laptop = Self { dir };
        laptop.script(
            "ssh",
            &format!(
                "echo $$ > '{}'\n{ssh}\n",
                laptop.dir.join("ssh.pid").display()
            ),
        );
        if recorder {
            laptop.script("pw-record", "exec sleep 60\n");
        }
        laptop
    }

    fn script(&self, name: &str, body: &str) {
        let path = self.dir.join("bin").join(name);
        std::fs::write(&path, format!("#!/bin/sh\nPATH=/usr/bin:/bin\n{body}")).expect("a script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("executable");
    }

    /// In its own process group, so a signal to the group is a terminal's Ctrl-C.
    fn start(&self) -> Child {
        Command::new(env!("CARGO_BIN_EXE_yantra"))
            .args(["mic", "fixture"])
            .env_clear()
            .env("PATH", self.dir.join("bin"))
            .env("HOME", self.dir.join("home"))
            .env("XDG_RUNTIME_DIR", self.dir.join("run"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .expect("yantra starts")
    }

    fn ssh_pid(&self) -> Option<u32> {
        std::fs::read_to_string(self.dir.join("ssh.pid"))
            .ok()?
            .trim()
            .parse()
            .ok()
    }

    fn until_ssh(&self) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(pid) = self.ssh_pid() {
                return pid;
            }
            assert!(Instant::now() < deadline, "the fake ssh never started");
            sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Laptop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn interrupt(group: &Child) {
    let sent = Command::new("kill")
        .args(["-INT", "--", &format!("-{}", group.id())])
        .status()
        .expect("kill runs");
    assert!(sent.success(), "the group was signalled");
}

fn exited(mut child: Child) -> (ExitStatus, String) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while child.try_wait().expect("a wait").is_none() {
        let late = Instant::now() > deadline;
        if late {
            let _ = child.kill();
        }
        assert!(!late, "yantra did not exit");
        sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().expect("its stderr");
    (
        output.status,
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// Gone, or a zombie nobody has reaped yet: either way nothing runs.
fn gone(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let running = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| {
                let after = stat.rfind(')')?;
                stat.get(after + 2..after + 3).map(|state| state != "Z")
            })
            .unwrap_or(false);
        if !running {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_laptop_without_pw_record_is_told_before_ssh_starts() {
    let laptop = Laptop::new("no-recorder", "exec sleep 30", false);
    let (status, said) = exited(laptop.start());
    assert!(!status.success(), "{said}");
    assert!(said.contains("`pw-record`"), "{said}");
    assert_eq!(laptop.ssh_pid(), None, "ssh started: {said}");
}

#[test]
fn ctrl_c_during_the_connect_drains_and_exits_cleanly() {
    let laptop = Laptop::new("connect", "sleep 2\ncat > /dev/null", true);
    let yantra = laptop.start();
    let ssh = laptop.until_ssh();
    interrupt(&yantra);
    let (status, said) = exited(yantra);
    assert_ne!(status.code(), Some(130), "{said}");
    assert_eq!(status.signal(), None, "{said}");
    assert!(status.success(), "{said}");
    assert!(gone(ssh), "the fake ssh is still running");
}

#[test]
fn a_second_ctrl_c_cuts_a_stalled_close_short() {
    let laptop = Laptop::new("stalled", "exec sleep 30", true);
    let yantra = laptop.start();
    let ssh = laptop.until_ssh();
    sleep(Duration::from_millis(300));
    interrupt(&yantra);
    sleep(Duration::from_millis(500));
    interrupt(&yantra);
    let second = Instant::now();
    let (status, said) = exited(yantra);
    assert!(
        second.elapsed() < Duration::from_secs(3),
        "the close ran its course: {:?}",
        second.elapsed()
    );
    assert!(!status.success(), "{said}");
    assert!(said.contains("cut the close short"), "{said}");
    assert!(gone(ssh), "the fake ssh is still running");
}
