//! One command that writes a Yantra box installer to a USB stick.

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use clap::Parser;
use include_dir::{Dir, include_dir};
use serde::Deserialize;

// Named one by one, so a local box/cache never lands in the binary.
static PAYLOAD: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../box/payload");
static UI: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../box/ui");
const FILES: [(&str, &str); 3] = [
    ("build.sh", include_str!("../../../box/build.sh")),
    ("flash.sh", include_str!("../../../box/flash.sh")),
    ("preseed.cfg", include_str!("../../../box/preseed.cfg")),
];
const TOOLS: [&str; 5] = ["podman", "curl", "openssl", "lsblk", "sudo"];

#[derive(Parser)]
#[command(version, about = "Write a Yantra box installer to a USB stick")]
struct Args {
    /// Build the ISO and stop, with no USB stick.
    #[arg(long)]
    no_flash: bool,
}

#[derive(Deserialize)]
struct Lsblk {
    blockdevices: Vec<Disk>,
}

#[derive(Deserialize)]
struct Disk {
    name: String,
    size: Option<String>,
    model: Option<String>,
    tran: Option<String>,
    #[serde(rename = "type")]
    kind: String,
}

/// Only whole USB disks: an internal disk must never be offered.
fn usb_disks(lsblk_json: &str) -> Result<Vec<Disk>> {
    let parsed: Lsblk = serde_json::from_str(lsblk_json).context("lsblk printed no JSON")?;
    Ok(parsed
        .blockdevices
        .into_iter()
        .filter(|d| d.kind == "disk" && d.tran.as_deref() == Some("usb"))
        .collect())
}

fn ask(prompt: &str, default: &str) -> Result<String> {
    print!("{prompt} [{default}]: ");
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line)?;
    let line = line.trim();
    Ok(if line.is_empty() { default } else { line }.to_owned())
}

fn on_path(tool: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {tool}")])
        .output()
        .is_ok_and(|o| o.status.success())
}

fn unpack(root: &Path) -> Result<()> {
    std::fs::create_dir_all(root.join("payload"))?;
    std::fs::create_dir_all(root.join("ui"))?;
    PAYLOAD.extract(root.join("payload"))?;
    UI.extract(root.join("ui"))?;
    for (name, body) in FILES {
        std::fs::write(root.join(name), body)?;
    }
    Ok(())
}

fn first_public_key(home: &Path) -> Option<PathBuf> {
    let mut keys: Vec<_> = std::fs::read_dir(home.join(".ssh"))
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "pub"))
        .collect();
    keys.sort();
    keys.into_iter().next()
}

fn run(script: &str, root: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<()> {
    let status = Command::new("bash")
        .arg(root.join(script))
        .args(args)
        .envs(env.iter().copied())
        .status()?;
    if !status.success() {
        bail!("{script} failed");
    }
    Ok(())
}

fn main() -> Result<()> {
    let args = Args::parse();
    if !cfg!(target_os = "linux") {
        bail!("yantra-box runs on Linux for now");
    }
    let missing: Vec<_> = TOOLS.iter().filter(|t| !on_path(t)).collect();
    if !missing.is_empty() {
        bail!("install these first: {missing:?}");
    }

    let home = PathBuf::from(std::env::var("HOME").context("HOME is not set")?);
    let root = home.join(".cache/yantra-box");
    unpack(&root)?;

    let device = if args.no_flash {
        None
    } else {
        let out = Command::new("lsblk")
            .args(["-Jdo", "NAME,SIZE,MODEL,TRAN,TYPE"])
            .output()?;
        let disks = usb_disks(&String::from_utf8_lossy(&out.stdout))?;
        if disks.is_empty() {
            bail!("no USB stick found: plug one in and run this again");
        }
        for (i, d) in disks.iter().enumerate() {
            let (size, model) = (
                d.size.as_deref().unwrap_or("?"),
                d.model.as_deref().unwrap_or("?"),
            );
            println!("  {}. /dev/{}  {size}  {model}", i + 1, d.name);
        }
        let pick: usize = ask("Which stick", "1")?.parse().context("type a number")?;
        let disk = pick
            .checked_sub(1)
            .and_then(|i| disks.get(i))
            .context("no such stick")?;
        Some(format!("/dev/{}", disk.name))
    };

    let key_default = first_public_key(&home)
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let key = ask("SSH public key", &key_default)?;
    if !Path::new(&key).is_file() {
        bail!("no public key at {key:?}: make one with ssh-keygen");
    }
    let user = ask("Login user", "yantra-owner")?;
    let host = ask("Machine name", "yantra-box")?;
    let tz = ask("Time zone", "UTC")?;

    run(
        "build.sh",
        &root,
        &[&key],
        &[
            ("BOX_USER", &user),
            ("BOX_HOSTNAME", &host),
            ("BOX_TZ", &tz),
        ],
    )?;

    let iso = root.join("out/yantra-box.iso");
    match device {
        None => println!(
            "The ISO is at {}. It holds secrets: delete it after use.",
            iso.display()
        ),
        Some(device) => {
            run("flash.sh", &root, &[&device], &[])?;
            // The ISO holds the password hash and the auth key.
            std::fs::remove_file(&iso)?;
            println!("Put the stick in the box, start it from USB, and press Enter.");
            println!("The box powers off when the install ends. Remove the stick and start it.");
            println!("Then run: ssh {host}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_whole_usb_disks_are_offered() {
        let json = r#"{"blockdevices":[
            {"name":"nvme0n1","size":"1T","model":"SSD","tran":"nvme","type":"disk"},
            {"name":"sda","size":"32G","model":"Stick","tran":"usb","type":"disk"},
            {"name":"sr0","size":"1G","model":"DVD","tran":"usb","type":"rom"},
            {"name":"loop0","size":"1G","model":null,"tran":null,"type":"loop"}
        ]}"#;
        let names: Vec<_> = usb_disks(json)
            .unwrap()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(names, ["sda"]);
    }

    #[test]
    fn unpack_writes_everything_the_build_reads() {
        let root = std::env::temp_dir().join(format!("yantra-box-{}", std::process::id()));
        unpack(&root).unwrap();
        for path in [
            "build.sh",
            "flash.sh",
            "preseed.cfg",
            "payload/late.sh",
            "ui/install.sh",
        ] {
            assert!(root.join(path).is_file(), "{path}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
