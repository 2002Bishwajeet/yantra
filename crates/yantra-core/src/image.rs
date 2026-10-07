//! An image pasted into the chat, carried to the machine the chat runs on
//! (Y-424).
//!
//! `ssh.rs`'s fourth call shape, [`Ssh::stdio`]: the bytes go on `ssh`'s stdin
//! over the multiplexed socket (I-20), and the command is still base64 (I-26,
//! I-35). An image lands in one directory per chat socket under the machine's
//! `TMPDIR`, outside every repository and worktree, under a name generated here
//! (I-24). **No image byte or size is ever logged or formatted** (Q5).

use std::future::Future;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::acp;
use crate::ssh::{self, Exec, Ssh};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The bytes start as none of the formats Claude's Read takes.
    #[error("that is not a PNG, JPEG, GIF or WebP image")]
    NotAnImage,

    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    /// `said` is the end of what the command and `ssh` said.
    #[error("the image could not be written on the machine: it exited {}{}", exited(*.status), colon(.said))]
    Put { status: Option<i32>, said: String },

    #[error("the chat's images could not be removed from the machine: it exited {}{}", exited(Some(*.status)), colon(.said))]
    Remove { status: i32, said: String },
}

fn exited(status: Option<i32>) -> String {
    status.map_or_else(
        || "on a signal".to_owned(),
        |code| format!("with status {code}"),
    )
}

fn colon(said: &str) -> String {
    if said.is_empty() {
        String::new()
    } else {
        format!(": {said}")
    }
}

/// The extension for an image, read from its magic bytes. A browser's MIME
/// type is not trusted.
pub fn kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else {
        None
    }
}

/// The images one chat socket attached: one directory on the machine, and a
/// counter that names each file in it.
#[derive(Debug, Default)]
pub struct Images {
    /// Made on the first image, so a socket that sends none has no directory.
    id: Option<String>,
    count: u32,
    /// The absolute directory, as the machine expanded it.
    dir: Option<String>,
}

impl Images {
    pub fn new() -> Self {
        Self::default()
    }

    /// Where the images are, once one has landed.
    pub fn dir(&self) -> Option<&str> {
        self.dir.as_deref()
    }

    /// Whether a write was tried, so a directory may exist to remove.
    pub fn used(&self) -> bool {
        self.id.is_some()
    }

    /// Writes `bytes` on the machine `ssh` reaches and returns its absolute path.
    pub async fn put(&mut self, ssh: &Ssh, bytes: &[u8]) -> Result<String, Error> {
        self.put_with(bytes, |command| write(ssh, command, bytes))
            .await
    }

    /// The generic half: `write` runs the command with `bytes` on its stdin and
    /// returns what it printed.
    pub async fn put_with<F, Fut>(&mut self, bytes: &[u8], write: F) -> Result<String, Error>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<String, Error>>,
    {
        let ext = kind(bytes).ok_or(Error::NotAnImage)?;
        let id = match &self.id {
            Some(id) => id.clone(),
            None => self.id.insert(ssh::nonce()?).clone(),
        };
        self.count += 1;
        let path = write(command(&id, self.count, ext)).await?;
        if let Some((dir, _)) = path.rsplit_once('/') {
            self.dir = Some(dir.to_owned());
        }
        Ok(path)
    }

    /// Removes the directory, and succeeds when there was none.
    pub async fn remove<E: Exec>(&self, exec: &E) -> Result<(), Error> {
        let Some(id) = &self.id else {
            return Ok(());
        };
        let out = exec
            .exec(&format!("{}; rm -rf \"$d\"", directory(id)))
            .await?;
        if !out.success() {
            return Err(Error::Remove {
                status: out.status,
                said: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
            });
        }
        Ok(())
    }
}

/// `${d%/}` because macOS's `TMPDIR` ends in a slash.
fn directory(id: &str) -> String {
    format!("d=\"${{TMPDIR:-/tmp}}\"; d=\"${{d%/}}/yantra-chat-{id}\"")
}

/// `umask` before `mkdir`, so the directory is 0700 and each image 0600.
fn command(id: &str, n: u32, ext: &str) -> String {
    format!(
        "umask 077; {}; mkdir -p \"$d\" && cat > \"$d/{n}.{ext}\" && printf %s \"$d/{n}.{ext}\"",
        directory(id)
    )
}

async fn write(ssh: &Ssh, command: String, bytes: &[u8]) -> Result<String, Error> {
    let ssh::Piped {
        mut child,
        mut stdin,
        mut stdout,
        stderr,
        log,
    } = ssh.stdio(&command)?;
    let diagnosis = acp::diagnosis(stderr, log);
    let fed = async move {
        let fed = stdin.write_all(bytes).await;
        // `cat` ends at EOF.
        drop(stdin);
        fed
    };
    let mut printed = Vec::new();
    let (fed, read) = tokio::join!(fed, stdout.read_to_end(&mut printed));
    let status = child.wait().await;
    let said = diagnosis.await.unwrap_or_default();
    let status = status.map_err(|error| Error::Put {
        status: None,
        said: error.to_string(),
    })?;
    // A login script may print first; the path is the last line.
    let printed = String::from_utf8_lossy(&printed);
    let path = printed.rsplit('\n').next().unwrap_or_default();
    if !status.success() || fed.is_err() || read.is_err() || path.is_empty() {
        return Err(Error::Put {
            status: status.code(),
            said,
        });
    }
    Ok(path.to_owned())
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn the_kind_is_read_from_the_magic_bytes() {
        assert_eq!(kind(PNG), Some("png"));
        assert_eq!(kind(b"\xff\xd8\xff\xe0\0\x10JFIF"), Some("jpg"));
        assert_eq!(kind(b"GIF87a\x01\0"), Some("gif"));
        assert_eq!(kind(b"GIF89a\x01\0"), Some("gif"));
        assert_eq!(kind(b"RIFF\x24\0\0\0WEBPVP8 "), Some("webp"));
    }

    #[test]
    fn junk_and_nothing_are_not_images() {
        assert_eq!(kind(b""), None);
        assert_eq!(kind(b"\x89PN"), None);
        assert_eq!(kind(b"%PDF-1.7"), None);
        assert_eq!(kind(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(kind(b"RIFF\x24\0\0\0WAVEfmt "), None);
        assert_eq!(kind(b"RIFF\x24\0"), None);
    }

    /// I-24: the only name in the command is the one generated here.
    #[test]
    fn the_command_names_only_the_generated_file() {
        assert_eq!(
            command("Y0123456789abcdef", 2, "png"),
            "umask 077; d=\"${TMPDIR:-/tmp}\"; d=\"${d%/}/yantra-chat-Y0123456789abcdef\"; \
             mkdir -p \"$d\" && cat > \"$d/2.png\" && printf %s \"$d/2.png\""
        );
    }

    #[tokio::test]
    async fn each_image_is_named_by_a_counter_in_one_directory() {
        let mut images = Images::new();
        assert!(!images.used());
        let mut sent = Vec::new();
        for _ in 0..2 {
            images
                .put_with(PNG, |command| {
                    let n = sent.len() + 1;
                    sent.push(command);
                    async move { Ok(format!("/tmp/yantra-chat-x/{n}.png")) }
                })
                .await
                .expect("it lands");
        }
        assert!(sent[0].contains("\"$d/1.png\""), "{}", sent[0]);
        assert!(sent[1].contains("\"$d/2.png\""), "{}", sent[1]);
        let id = |command: &str| {
            command
                .split("yantra-chat-")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .map(str::to_owned)
        };
        assert_eq!(id(&sent[0]), id(&sent[1]), "one directory per socket");
        assert_eq!(images.dir(), Some("/tmp/yantra-chat-x"));
        assert!(images.used());
    }

    #[tokio::test]
    async fn a_non_image_writes_nothing() {
        let mut images = Images::new();
        let refused = images
            .put_with(b"#!/bin/sh\nrm -rf ~", |_| async {
                panic!("nothing is sent for a non-image")
            })
            .await;
        assert!(matches!(refused, Err(Error::NotAnImage)), "{refused:?}");
        assert!(!images.used());
        assert_eq!(images.dir(), None);
    }

    #[tokio::test]
    async fn a_failed_write_leaves_no_directory_to_name() {
        let mut images = Images::new();
        let failed = images
            .put_with(PNG, |_| async {
                Err(Error::Put {
                    status: Some(1),
                    said: "cat: write error: No space left on device".to_owned(),
                })
            })
            .await
            .expect_err("it failed");
        assert_eq!(
            failed.to_string(),
            "the image could not be written on the machine: it exited with status 1: \
             cat: write error: No space left on device"
        );
        assert_eq!(images.dir(), None);
        assert!(images.used(), "mkdir may have run, so remove still runs");
    }
}
