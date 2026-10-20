//! Y-492 against a real sshd and real git, per §B3: a thread commits with the
//! machine's own identity and a message a stubbed `claude -p` writes, and
//! pushes to a bare `origin` in the container. The fixture has no git
//! identity, which is the case the commit must refuse.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use base64::Engine as _;
use common::{SshFixture, USER};
use yantra_core::commit::{self, Error};
use yantra_core::github::{Github, IssueRef, Token};
use yantra_core::ssh::{Exec as _, Machine, Ssh};
use yantra_core::thread::{self, Place};
use yantra_core::tmux::Tmux;
use yantra_core::workspace::Workspace;

/// Where Claude Code's installer puts the binary, as in `tests/agent.rs`.
const INSTALLED_AT: &str = "/home/yantra/.local/bin/claude";
const SEEN_CWD: &str = "/tmp/commit-claude-cwd";
const SEEN_STDIN: &str = "/tmp/commit-claude-stdin";
const SUBJECT: &str = "Don't add $(id) or `id`";

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
fn state_dir(label: &str) -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join(label);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

async fn lab(label: &str, repo: &str) -> Result<Option<(SshFixture, Ssh, Workspace)>> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(None);
    };
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: state_dir(label)?,
    })?;
    assert_eq!(
        fixture
            .run("git config --global user.email || echo none")?
            .trim(),
        "none",
        "the fixture has no git identity"
    );
    fixture.run(&format!(
        "mkdir -p {repo} && cd {repo} && git init -q -b main && printf 'one\\n' > kept.txt \
         && git add kept.txt && git -c user.name=t -c user.email=t@example.com commit -qm one"
    ))?;
    let workspace = Workspace {
        name: label.to_owned(),
        machine: "fixture".to_owned(),
        repo: repo.into(),
        startup: None,
    };
    Ok(Some((fixture, ssh, workspace)))
}

/// Records where it ran and what it read, and answers as `claude -p
/// --output-format json --json-schema` does.
async fn install_claude(ssh: &Ssh) -> Result<()> {
    let reply = serde_json::json!({
        "type": "result",
        "is_error": false,
        "result": "",
        "structured_output": {"subject": SUBJECT, "body": "- tracked and untracked"},
    });
    let script = format!(
        "#!/bin/sh\n\
         pwd > {SEEN_CWD}\n\
         cat > {SEEN_STDIN}\n\
         cat <<'EOF'\n{reply}\nEOF\n"
    );
    let b64 = base64::engine::general_purpose::STANDARD.encode(script);
    let out = ssh
        .exec(&format!(
            "mkdir -p ~/.local/bin && printf %s '{b64}' | base64 -d > {INSTALLED_AT} \
             && chmod 755 {INSTALLED_AT}"
        ))
        .await?;
    assert!(out.success(), "{}", String::from_utf8_lossy(&out.stderr));
    Ok(())
}

fn head(fixture: &SshFixture, place: &Place) -> Result<String> {
    Ok(fixture
        .run(&format!("git -C {} rev-parse HEAD", place.worktree))?
        .trim()
        .to_owned())
}

#[tokio::test]
async fn a_thread_commits_with_the_machines_identity_and_claudes_message() -> Result<()> {
    const REPO: &str = "/home/yantra/commits";
    let Some((fixture, ssh, workspace)) = lab("yt-cmt", REPO).await? else {
        return Ok(());
    };
    install_claude(&ssh).await?;
    let place = thread::open(&ssh, &workspace).await?;
    let wt = place.worktree.clone();
    fixture.run(&format!(
        "cd {wt} && printf 'two\\n' >> kept.txt && printf 'new\\n' > made.txt"
    ))?;
    let before = head(&fixture, &place)?;

    // (a) No identity: refused before anything is staged, and HEAD stays.
    assert!(matches!(
        commit::commit(&ssh, &place, "Add x").await,
        Err(Error::NoIdentity)
    ));
    assert_eq!(head(&fixture, &place)?, before);
    assert_eq!(
        fixture.run(&format!("git -C {wt} status --porcelain"))?,
        " M kept.txt\n?? made.txt\n",
        "nothing was staged"
    );

    // (b) A repository identity: claude's message commits both files.
    fixture.run(&format!(
        "git -C {REPO} config user.name Owner && git -C {REPO} config user.email owner@example.com"
    ))?;
    let message = commit::draft(&ssh, &place, None).await?;
    assert_eq!(message, format!("{SUBJECT}\n\n- tracked and untracked"));
    let seen = fixture.run(&format!("cat {SEEN_STDIN}"))?;
    assert!(seen.starts_with("You write concise git commit messages."));
    assert!(seen.contains("diff --git a/kept.txt b/kept.txt"), "{seen}");
    assert!(seen.contains("+two"), "{seen}");
    assert!(seen.contains("diff --git a/made.txt b/made.txt"), "{seen}");
    let cwd = fixture.run(&format!("cat {SEEN_CWD}"))?;
    assert!(!cwd.trim().starts_with(&wt), "claude ran in {cwd}");
    assert!(
        fixture
            .run(&format!("test -e {} && echo left || echo gone", cwd.trim()))?
            .trim()
            == "gone",
        "the directory claude ran in is removed"
    );
    assert_eq!(
        fixture.run(&format!("git -C {wt} status --porcelain"))?,
        " M kept.txt\n?? made.txt\n",
        "drafting leaves the real index alone"
    );

    let committed = commit::commit(&ssh, &place, &message).await?;
    assert_eq!(committed.subject, SUBJECT);
    assert_eq!(committed.commit, head(&fixture, &place)?);
    assert_eq!(
        fixture.run(&format!("git -C {wt} log -1 --format=%B"))?,
        format!("{message}\n\n")
    );
    assert_eq!(
        fixture.run(&format!("git -C {wt} log -1 --format='%an <%ae>'"))?,
        "Owner <owner@example.com>\n"
    );
    assert_eq!(
        fixture.run(&format!(
            "git -C {wt} show --name-only --format= HEAD | sort"
        ))?,
        "kept.txt\nmade.txt\n"
    );
    assert_eq!(fixture.run(&format!("git -C {wt} status --porcelain"))?, "");

    // (c) Nothing left to commit, and nothing to draft.
    assert!(matches!(
        commit::commit(&ssh, &place, "again").await,
        Err(Error::NothingToCommit)
    ));
    assert!(matches!(
        commit::draft(&ssh, &place, None).await,
        Err(Error::NothingToCommit)
    ));
    assert_eq!(head(&fixture, &place)?, committed.commit);

    // (d) A pre-commit hook that fails: HEAD and the index stay as they were.
    fixture.run(&format!(
        "cd {wt} && printf 'staged\\n' > staged.txt && git add staged.txt \
         && printf 'loose\\n' > loose.txt \
         && printf '#!/bin/sh\\necho lint failed >&2\\nexit 1\\n' > {REPO}/.git/hooks/pre-commit \
         && chmod 755 {REPO}/.git/hooks/pre-commit"
    ))?;
    let index = format!("git -C {wt} status --porcelain");
    assert_eq!(fixture.run(&index)?, "A  staged.txt\n?? loose.txt\n");
    assert!(matches!(
        commit::commit(&ssh, &place, "Add both").await,
        Err(Error::Git { stderr }) if stderr.contains("lint failed")
    ));
    assert_eq!(head(&fixture, &place)?, committed.commit);
    assert_eq!(
        fixture.run(&index)?,
        "A  staged.txt\n?? loose.txt\n",
        "a failed commit leaves the index as it was"
    );

    // (e) Inside a tmux server, as on a Mac (I-44): the reply and a refusal
    // both come back through `run-shell`.
    fixture.run("tmux new-session -d -s login")?;
    let tmux = Tmux::resolve(&ssh).await?;
    let inside = commit::draft(&ssh, &place, Some(tmux.path())).await?;
    assert_eq!(inside, message);

    // (f) A patch over 256 KiB reaches claude cut, with a line that says so.
    fixture.run(&format!(
        "head -c 300000 /dev/zero | tr '\\0' a | fold -w 100 > {wt}/big.txt"
    ))?;
    commit::draft(&ssh, &place, None).await?;
    let seen = fixture.run(&format!("cat {SEEN_STDIN}"))?;
    assert!(seen.contains("diff --git a/big.txt b/big.txt"));
    assert!(
        seen.trim_end()
            .ends_with("[The patch is cut at 256 KiB. The file list above is complete.]"),
        "{}",
        &seen[seen.len().saturating_sub(200)..]
    );
    fixture.run(&format!("mv {INSTALLED_AT} {INSTALLED_AT}.off"))?;
    assert!(matches!(
        commit::draft(&ssh, &place, Some(tmux.path())).await,
        Err(Error::Claude { said }) if said.starts_with("claude was not found")
    ));
    Ok(())
}

#[tokio::test]
async fn a_push_sets_the_upstream_and_a_refused_one_sets_nothing() -> Result<()> {
    const REPO: &str = "/home/yantra/pushes";
    const ORIGIN: &str = "/home/yantra/origin.git";
    let Some((fixture, ssh, workspace)) = lab("yt-psh", REPO).await? else {
        return Ok(());
    };
    fixture.run(&format!(
        "git -C {REPO} config user.name Owner && git -C {REPO} config user.email owner@example.com"
    ))?;

    // No origin yet.
    let place = thread::open(&ssh, &workspace).await?;
    let wt = place.worktree.clone();
    assert!(matches!(
        commit::push(&ssh, &place, None, None).await,
        Err(Error::NoRemote)
    ));
    fixture.run(&format!(
        "git init -q --bare {ORIGIN} && git -C {REPO} remote add origin {ORIGIN} \
         && printf '#!/bin/sh\\necho declined >&2\\nexit 1\\n' > {ORIGIN}/hooks/pre-receive \
         && chmod 755 {ORIGIN}/hooks/pre-receive"
    ))?;
    let issue: IssueRef = "o/r#7".parse()?;
    let named = format!("yantra/7-{}", thread::name(&place));
    let merge = format!(
        "git -C {REPO} config --get branch.{}.merge || true",
        place.branch
    );

    fixture.run(&format!("cd {wt} && printf 'a\\n' > a.txt"))?;
    commit::commit(&ssh, &place, "Add a").await?;

    // (e) A hook that declines: refused, and no upstream is set.
    assert!(matches!(
        commit::push(&ssh, &place, Some(&issue), None).await,
        Err(Error::Refused { reason }) if reason.contains("pre-receive hook declined")
    ));
    assert_eq!(fixture.run(&merge)?, "", "no upstream after a refusal");

    // (d) The push sets the upstream to the generated name. An upstream whose
    // remote is a URL, which can hold a credential, is not followed or echoed.
    fixture.run(&format!(
        "rm {ORIGIN}/hooks/pre-receive \
         && git -C {REPO} config branch.{b}.remote https://me:ghp_secret@example.invalid/r.git \
         && git -C {REPO} config branch.{b}.merge refs/heads/yantra/elsewhere",
        b = place.branch,
    ))?;
    let pushed = commit::push(&ssh, &place, Some(&issue), None).await?;
    assert_eq!(pushed.remote, "origin");
    assert_eq!(pushed.branch, named);
    assert_eq!(fixture.run(&merge)?, format!("refs/heads/{named}\n"));
    assert_eq!(
        fixture.run(&format!("git -C {ORIGIN} rev-parse refs/heads/{named}"))?,
        format!("{}\n", head(&fixture, &place)?)
    );

    // A second commit goes to the same upstream, whatever issue is passed.
    fixture.run(&format!("cd {wt} && printf 'b\\n' > b.txt"))?;
    commit::commit(&ssh, &place, "Add b").await?;
    let again = commit::push(&ssh, &place, None, None).await?;
    assert_eq!(again.branch, named);
    assert_eq!(
        fixture.run(&format!("git -C {ORIGIN} rev-parse refs/heads/{named}"))?,
        format!("{}\n", head(&fixture, &place)?)
    );

    // (e) A non-fast-forward: the generated name already holds other work.
    let other = thread::open(&ssh, &workspace).await?;
    let other_named = format!("yantra/{}", thread::name(&other));
    let other_merge = format!(
        "git -C {REPO} config --get branch.{}.merge || true",
        other.branch
    );
    fixture.run(&format!(
        "cd {REPO} && printf 'theirs\\n' > theirs.txt && git add theirs.txt \
         && git commit -qm theirs && git push -q origin HEAD:refs/heads/{other_named}"
    ))?;
    fixture.run(&format!(
        "cd {} && printf 'mine\\n' > mine.txt",
        other.worktree
    ))?;
    commit::commit(&ssh, &other, "Add mine").await?;
    assert!(matches!(
        commit::push(&ssh, &other, None, None).await,
        Err(Error::Refused { reason }) if reason.contains("non-fast-forward")
    ));
    assert_eq!(
        fixture.run(&other_merge)?,
        "",
        "no upstream after a refusal"
    );

    // (f) main tracks origin/main and autoSetupMerge=inherit: the thread
    // branch tracks nothing, and an upstream it inherited before --no-track
    // does not push to main.
    fixture.run(&format!(
        "git -C {REPO} push -q -u origin main && git -C {REPO} config branch.autoSetupMerge inherit"
    ))?;
    let main_before = fixture.run(&format!("git -C {ORIGIN} rev-parse refs/heads/main"))?;
    let inherited = thread::open(&ssh, &workspace).await?;
    let inherited_named = format!("yantra/{}", thread::name(&inherited));
    let inherited_merge = format!(
        "git -C {REPO} config --get branch.{}.merge || true",
        inherited.branch
    );
    assert_eq!(fixture.run(&inherited_merge)?, "", "no inherited upstream");
    fixture.run(&format!(
        "git -C {REPO} config branch.{b}.remote origin \
         && git -C {REPO} config branch.{b}.merge refs/heads/main \
         && cd {wt} && printf 'c\\n' > c.txt",
        b = inherited.branch,
        wt = inherited.worktree,
    ))?;
    commit::commit(&ssh, &inherited, "Add c").await?;
    let pushed = commit::push(&ssh, &inherited, None, None).await?;
    assert_eq!(pushed.branch, inherited_named);
    assert_eq!(
        fixture.run(&format!("git -C {ORIGIN} rev-parse refs/heads/main"))?,
        main_before,
        "main on origin is untouched"
    );
    assert_eq!(
        fixture.run(&inherited_merge)?,
        format!("refs/heads/{inherited_named}\n")
    );
    Ok(())
}

/// A loopback GitHub that answers each request in turn and returns what it
/// was sent. The GitHub calls stay faked; the tip read is what goes over ssh.
fn github_answering(
    replies: Vec<(&'static str, &'static str)>,
) -> (Github, std::thread::JoinHandle<Vec<String>>) {
    use std::io::{Read as _, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let base = format!("http://{}", listener.local_addr().expect("its address"));
    let served = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for (status, body) in replies {
            let (mut stream, _) = listener.accept().expect("a connection");
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                let text = String::from_utf8_lossy(&request).into_owned();
                if let Some((head, sent)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")?
                                .trim()
                                .parse::<usize>()
                                .ok()
                        })
                        .unwrap_or(0);
                    if sent.len() >= length {
                        break;
                    }
                }
                match stream.read(&mut byte) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => request.push(byte[0]),
                }
            }
            seen.push(String::from_utf8_lossy(&request).into_owned());
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .expect("the answer is written");
        }
        seen
    });
    (Github::at(&base, &base), served)
}

/// Y-449 per §B3: `open_pr` reads the pushed tip over the real ssh exec, so
/// a pushed thread opens a PR with its tip's text and a commit after the push
/// is refused.
#[tokio::test]
async fn a_pr_opens_from_the_pushed_tip_read_over_ssh() -> Result<()> {
    const REPO: &str = "/home/yantra/prs";
    const ORIGIN: &str = "/home/yantra/prs-origin.git";
    const NONE_OPEN: &str = "[]";
    let Some((fixture, ssh, workspace)) = lab("yt-pr", REPO).await? else {
        return Ok(());
    };
    fixture.run(&format!(
        "git -C {REPO} config user.name Owner && git -C {REPO} config user.email owner@example.com \
         && git init -q --bare {ORIGIN} && git -C {REPO} remote add origin {ORIGIN}"
    ))?;
    let place = thread::open(&ssh, &workspace).await?;
    fixture.run(&format!("cd {} && printf 'a\\n' > a.txt", place.worktree))?;
    commit::commit(&ssh, &place, "Fix the thing\n\nwhy").await?;
    let issue: IssueRef = "o/r#7".parse()?;
    let pushed = commit::push(&ssh, &place, Some(&issue), None).await?;
    // The remote-tracking ref stays; only the URL now names github.com.
    fixture.run(&format!(
        "git -C {REPO} remote set-url origin https://github.com/o/r.git"
    ))?;
    let found = |listed: Vec<thread::Listed>| {
        listed
            .into_iter()
            .find(|found| found.place.branch == place.branch)
            .expect("the thread")
    };
    let mut thread = found(thread::listed(&ssh, &workspace).await?);
    thread.issue = Some(issue.to_string());
    let token = Token::new("gho_notarealtoken".to_owned());

    let (github, served) = github_answering(vec![
        ("200 OK", NONE_OPEN),
        ("200 OK", r#"{"default_branch":"main"}"#),
        (
            "201 Created",
            r#"{"number":3,"html_url":"https://github.com/o/r/pull/3","state":"open","merged_at":null}"#,
        ),
    ]);
    let opened = commit::open_pr(&ssh, &thread, &github, &token, None, None).await?;
    assert!(opened.created);
    assert_eq!(opened.number, 3);
    let seen = served.join().expect("the stub thread");
    let sent: serde_json::Value =
        serde_json::from_str(seen[2].rsplit("\r\n\r\n").next().unwrap_or_default())?;
    assert_eq!(
        sent,
        serde_json::json!({
            "head": format!("o:{}", pushed.branch),
            "base": "main",
            "title": "Fix the thing",
            "body": "why\n\nCloses #7",
        })
    );

    fixture.run(&format!("cd {} && printf 'b\\n' > b.txt", place.worktree))?;
    commit::commit(&ssh, &place, "Add b").await?;
    let (github, _served) = github_answering(vec![("200 OK", NONE_OPEN)]);
    assert!(matches!(
        commit::open_pr(&ssh, &thread, &github, &token, None, None).await,
        Err(commit::Failed::Ahead)
    ));
    Ok(())
}
