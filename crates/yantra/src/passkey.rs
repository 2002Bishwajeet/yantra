//! `yantra passkey` and `yantra session`: the owner's devices, on the hub
//! ([ADR-0044](../../../docs/adr/0044-a-write-needs-the-owners-passkey.md)
//! decisions 2 and 9). They speak HTTP on `yantrad`'s socket, where the
//! kernel names the account (ADR-0042), so they need no passkey (decision 10).

use std::io::{Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

pub const SOCKET: &str = "/run/yantra/yantrad.sock";

/// What the person reads when there is no socket here.
const NOT_THE_HUB: &str = "run this on the hub, where yantrad runs, as the yantra account: \
                           ssh <hub> sudo -u yantra yantra passkey code";

/// One request on the socket at `socket`: the status and the body.
pub fn send(socket: &Path, method: &str, path: &str) -> Result<(u16, String), String> {
    let mut stream = UnixStream::connect(socket).map_err(|error| {
        format!(
            "no yantrad at {} ({error}): {NOT_THE_HUB}",
            socket.display()
        )
    })?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: yantra\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    )
    .map_err(|error| format!("could not write to yantrad: {error}"))?;
    let mut answer = Vec::new();
    stream
        .read_to_end(&mut answer)
        .map_err(|error| format!("yantrad did not answer: {error}"))?;
    parse(&String::from_utf8_lossy(&answer))
}

/// The status line's code and the body, which may be chunked.
fn parse(answer: &str) -> Result<(u16, String), String> {
    let (head, body) = answer
        .split_once("\r\n\r\n")
        .ok_or("yantrad sent half an answer")?;
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or("yantrad sent no status")?;
    let chunked = head
        .lines()
        .any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked"));
    Ok((
        status,
        if chunked {
            unchunk(body)
        } else {
            body.to_owned()
        },
    ))
}

fn unchunk(mut body: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = body.split_once("\r\n") {
        let Ok(size) = usize::from_str_radix(size.trim(), 16) else {
            break;
        };
        if size == 0 || rest.len() < size {
            break;
        }
        out.push_str(&rest[..size]);
        body = rest[size..].trim_start_matches("\r\n");
    }
    out
}

/// A 2xx body, or the daemon's own words for a refusal.
pub fn call(socket: &Path, method: &str, path: &str) -> Result<String, String> {
    let (status, body) = send(socket, method, path)?;
    if (200..300).contains(&status) {
        Ok(body)
    } else {
        Err(format!("yantrad answered {status}: {}", body.trim()))
    }
}

/// `%`-escapes everything but unreserved characters, for a passkey's name.
pub fn segment(name: &str) -> String {
    name.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// `GET /api/passkey` in lines a person reads.
pub fn listed(body: &str) -> Result<String, String> {
    let listed: Value =
        serde_json::from_str(body).map_err(|error| format!("yantrad sent no list: {error}"))?;
    let mut out = String::new();
    if let Some(id) = listed["relying_party"].as_str() {
        out.push_str(&format!("Passkeys work at {id}.\n"));
    }
    let keys = listed["passkeys"].as_array().cloned().unwrap_or_default();
    if keys.is_empty() {
        out.push_str("No passkey is enrolled. Run yantra passkey code to add one.\n");
    }
    for key in keys {
        out.push_str(&format!(
            "passkey  {}  made {}\n",
            key["name"].as_str().unwrap_or("?"),
            when(&key["made"])
        ));
    }
    for session in listed["sessions"].as_array().cloned().unwrap_or_default() {
        out.push_str(&format!(
            "session  {}  {} with {}  ends {}\n",
            session["id"].as_str().unwrap_or("?"),
            session["device"].as_str().unwrap_or("?"),
            session["passkey"].as_str().unwrap_or("?"),
            when(&session["ends"])
        ));
    }
    Ok(out)
}

fn when(seconds: &Value) -> String {
    seconds
        .as_i64()
        .and_then(|seconds| time::OffsetDateTime::from_unix_timestamp(seconds).ok())
        .map(|at| at.date().to_string())
        .unwrap_or_else(|| "?".to_owned())
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_and_a_chunked_answer_read_the_same() {
        let plain = "HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello";
        let chunked =
            "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n3\r\nhel\r\n2\r\nlo\r\n0\r\n\r\n";

        assert_eq!(parse(plain), Ok((200, "hello".to_owned())));
        assert_eq!(parse(chunked), Ok((200, "hello".to_owned())));
    }

    #[test]
    fn a_name_with_a_space_is_one_path_segment() {
        assert_eq!(segment("Biswa's iPhone"), "Biswa%27s%20iPhone");
        assert_eq!(segment("../x"), "..%2Fx");
    }

    #[test]
    fn no_socket_says_to_run_it_on_the_hub() {
        let said =
            send(Path::new("/nowhere/yantrad.sock"), "GET", "/api/passkey").expect_err("no socket");

        assert!(said.contains("run this on the hub"), "{said}");
    }

    #[test]
    fn the_list_names_the_relying_party_each_passkey_and_each_session() {
        let body = r#"{"relying_party":"hub.example.ts.net",
            "passkeys":[{"name":"iPhone","made":1762819200}],
            "sessions":[{"id":"ab12","passkey":"iPhone","device":"Mac","made":1762819200,
                         "ends":1765411200,"this_device":false}]}"#;

        let out = listed(body).expect("a list");

        assert!(out.contains("hub.example.ts.net"), "{out}");
        assert!(out.contains("passkey  iPhone  made 2025-11-11"), "{out}");
        assert!(
            out.contains("session  ab12  Mac with iPhone  ends 2025-12-11"),
            "{out}"
        );
    }
}
