//! Caddy's admin API under a real Caddy and a real `systemd`, in a disposable
//! podman container (§B3, Y-777).
//!
//! Caddy listens on `127.0.0.1:2019` unless its Caddyfile says `admin off`, and
//! it asks for no credential there. `yantrad` trusts the account Caddy runs as
//! on its socket (ADR-0042), so an account that reaches that port can act as
//! the proxy. The test first shows the old Caddyfile open to `deploy`, and then
//! shows [`install.sh`] and [`domain-setup.sh`] closing it. `install.sh` must
//! also close it where the global block is not a bare `{` on the first line,
//! and must leave a Caddyfile that Caddy would refuse with the line added.
//!
//! The site is plain http on a loopback port, because Fedora's Caddy has no
//! Cloudflare module and the container has no tailnet address. Nothing listens
//! on the socket, so a site that still answers says 502.
//!
//! [`install.sh`]: ../../../install.sh
//! [`domain-setup.sh`]: ../../../box/domain-setup.sh

mod common;

use anyhow::{Context, Result, ensure};

use common::{Systemd, UNPRIVILEGED};

const INSTALL: &str = include_str!("../../../install.sh");
const DOMAIN_SETUP: &str = include_str!("../../../box/domain-setup.sh");

const CADDY: &str = "caddy.service";
const CADDYFILE: &str = "/etc/caddy/Caddyfile";
const ADMIN: &str = "http://127.0.0.1:2019/config/";
const DASHBOARD: &str = "http://127.0.0.1:8080/";

/// The global block `domain-setup.sh` wrote before this row.
const OLD_GLOBAL: &str = "{\n    auto_https disable_redirects\n}\n";

const SITE: &str = "
http://127.0.0.1:8080 {
    reverse_proxy unix//run/yantra/yantrad.sock {
        header_up X-Forwarded-For {remote_host}
    }
}
";

/// curl's exit code for a port that refuses the connection.
const REFUSED: i32 = 7;

#[test]
fn admin_off_closes_the_port_that_any_account_on_the_box_could_use() -> Result<()> {
    let Some(fixture) = Systemd::start()? else {
        return Ok(());
    };

    write(&fixture, &format!("{OLD_GLOBAL}{SITE}"))?;
    fixture.run(&["systemctl", "start", CADDY])?;
    assert_eq!(
        asked(&fixture, ADMIN)?,
        (Some(0), "200".to_owned()),
        "the old Caddyfile gives its whole config to an account that is not caddy"
    );
    let owner = owner_and_mode(&fixture)?;

    let said = close_the_admin_api(&fixture)?;
    assert!(said.contains("admin API is now off"), "{said}");
    let closed = fixture.run(&["cat", CADDYFILE])?;
    assert_eq!(
        closed,
        format!("{{\n    admin off\n    auto_https disable_redirects\n}}\n{SITE}")
    );
    assert_eq!(owner_and_mode(&fixture)?, owner);
    assert_closed(&fixture)?;

    let pid = fixture.property(CADDY, "MainPID")?;
    assert_eq!(close_the_admin_api(&fixture)?, "", "a second run is silent");
    assert_eq!(fixture.run(&["cat", CADDYFILE])?, closed);
    assert_eq!(
        fixture.property(CADDY, "MainPID")?,
        pid,
        "a second run restarts nothing"
    );

    write(&fixture, &format!("{}{SITE}", domain_setup_global()?))?;
    fixture.run(&["systemctl", "restart", CADDY])?;
    assert_closed(&fixture)?;

    let commented = OLD_GLOBAL.replacen("{\n", "{ # global options\n", 1);
    for (shape, old) in [
        ("a comment after the brace", format!("{commented}{SITE}")),
        (
            "CRLF line ends",
            format!("{OLD_GLOBAL}{SITE}").replace('\n', "\r\n"),
        ),
        (
            "a snippet before the block",
            format!("(common) {{\n    encode gzip\n}}\n\n{OLD_GLOBAL}{SITE}"),
        ),
    ] {
        restart_on(&fixture, &old)?;
        assert_eq!(asked(&fixture, ADMIN)?.1, "200", "{shape}: open before");
        let said = close_the_admin_api(&fixture)?;
        assert!(said.contains("admin API is now off"), "{shape}: {said}");
        assert_closed(&fixture)?;
    }

    // The brace opens the site, so `admin off` after it is a file that Caddy refuses.
    let unbraced = "http://127.0.0.1:8080\n{\n    reverse_proxy unix//run/yantra/yantrad.sock\n}\n";
    restart_on(&fixture, unbraced)?;
    let pid = fixture.property(CADDY, "MainPID")?;
    let said = close_the_admin_api(&fixture)?;
    assert!(said.contains("is not changed"), "{said}");
    assert_eq!(fixture.run(&["cat", CADDYFILE])?, unbraced);
    fixture.run(&["test", "!", "-e", "/etc/caddy/Caddyfile.admin-off"])?;
    assert_eq!(fixture.property(CADDY, "MainPID")?, pid, "no restart");
    assert_eq!(
        asked(&fixture, DASHBOARD)?.1,
        "502",
        "the site still answers"
    );
    Ok(())
}

fn write(fixture: &Systemd, caddyfile: &str) -> Result<()> {
    let to_file = format!("printf %s \"$1\" >{CADDYFILE}");
    fixture.run(&["sh", "-c", &to_file, "sh", caddyfile])?;
    Ok(())
}

/// Caddy restarted on `caddyfile`. systemd refuses a sixth start in ten seconds, so the
/// count starts again first.
fn restart_on(fixture: &Systemd, caddyfile: &str) -> Result<()> {
    write(fixture, caddyfile)?;
    fixture.run(&["systemctl", "reset-failed", CADDY])?;
    fixture.run(&["systemctl", "restart", CADDY])?;
    Ok(())
}

/// What `deploy` gets from `url`: curl's exit code and the HTTP status.
fn asked(fixture: &Systemd, url: &str) -> Result<(Option<i32>, String)> {
    let out = fixture.exec_as(
        UNPRIVILEGED,
        &["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", url],
    )?;
    Ok((out.status.code(), String::from_utf8(out.stdout)?))
}

fn assert_closed(fixture: &Systemd) -> Result<()> {
    assert_eq!(fixture.property(CADDY, "ActiveState")?, "active");
    assert_eq!(asked(fixture, ADMIN)?.0, Some(REFUSED));
    assert_eq!(
        asked(fixture, DASHBOARD)?,
        (Some(0), "502".to_owned()),
        "the site must still answer"
    );
    Ok(())
}

fn owner_and_mode(fixture: &Systemd) -> Result<String> {
    fixture.run(&["stat", "-c", "%U:%G %a", CADDYFILE])
}

/// `install.sh`'s `close_the_admin_api`, run as it runs for an account that
/// needs sudo, and what it printed.
fn close_the_admin_api(fixture: &Systemd) -> Result<String> {
    let start = INSTALL
        .find("close_the_admin_api() {")
        .context("install.sh has close_the_admin_api")?;
    let end = start + INSTALL[start..].find("\n}\n").context("it ends")? + 3;
    let script = format!(
        "set -euo pipefail\nas_root() {{ sudo \"$@\"; }}\n{}close_the_admin_api {CADDYFILE}\n",
        &INSTALL[start..end]
    );
    let out = fixture.exec_as(UNPRIVILEGED, &["bash", "-c", &script])?;
    ensure!(
        out.status.success(),
        "close_the_admin_api failed ({}): {}",
        out.status,
        String::from_utf8_lossy(&out.stderr).trim()
    );
    Ok(String::from_utf8(out.stdout)?)
}

/// The global block `domain-setup.sh` writes now, so this test follows the script.
fn domain_setup_global() -> Result<&'static str> {
    let heredoc = "cat >/etc/caddy/Caddyfile <<CFG\n";
    let start = DOMAIN_SETUP
        .find(heredoc)
        .context("domain-setup.sh writes the Caddyfile")?
        + heredoc.len();
    let end = start + DOMAIN_SETUP[start..].find("\n}\n").context("it ends")? + 3;
    Ok(&DOMAIN_SETUP[start..end])
}
