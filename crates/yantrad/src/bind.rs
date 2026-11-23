//! Which GitHub repository a thread's PR verbs may write ([ADR-0045], the
//! notes of 2026-11-12 and 2026-11-23, Y-782).
//!
//! An agent in a worktree can rewrite a remote in git config. So the store
//! keeps `owner/repo` for each thread, and the PR verbs refuse a remote that
//! names another one. A new thread takes the clone record, which no agent can
//! change, or the repository's `origin` at that moment. A row from before
//! this binds on its first PR verb.
//!
//! [ADR-0045]: ../../../docs/adr/0045-the-hub-keeps-a-thread-store.md

use yantra_core::commit;
use yantra_core::ssh::Exec;
use yantra_core::thread;
use yantra_core::workspace::Workspace;

use crate::store::{self, Store};
use crate::write::chain;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Commit(#[from] commit::Failed),

    #[error(transparent)]
    Store(#[from] store::Error),
}

/// The repository a thread made now in `workspace` takes: the clone record,
/// else the `origin` the folder has now. `None` is a folder with neither, or
/// a read that failed; the thread then binds on its first PR verb.
pub async fn repository<E: Exec>(store: &Store, workspace: &Workspace, exec: &E) -> Option<String> {
    let path = workspace.repo.to_string_lossy();
    let read = match store.cloned(&workspace.machine, &path).await {
        Ok(None) => commit::origin(exec, &path)
            .await
            .map_err(|error| chain(&error)),
        cloned => cloned.map_err(|error| chain(&error)),
    };
    read.unwrap_or_else(|said| {
        tracing::warn!(
            "{}: a new thread's repository was not read: {said}",
            workspace.name
        );
        None
    })
}

/// Binds the thread [`thread::start`] made, before any agent runs in it.
pub async fn created<E: Exec>(
    store: &Store,
    workspace: &Workspace,
    exec: &E,
    opened: &thread::Opened,
) {
    let Some(repo) = repository(store, workspace, exec).await else {
        return;
    };
    let bound = store.bind(
        &workspace.name,
        &opened.thread,
        &workspace.machine,
        &opened.branch,
        &opened.worktree,
        &repo,
    );
    if let Err(error) = bound.await {
        tracing::warn!(
            "{}: thread {} is not bound to {repo}: {}",
            workspace.name,
            opened.thread,
            chain(&error)
        );
    }
}

/// The repository the PR verbs may write for thread `found`: its row's. A row
/// with none takes the clone record, else the upstream it has now, and keeps
/// it. The store's answer is returned, so the first binding wins.
pub async fn bound(
    store: &Store,
    workspace: &Workspace,
    found: &thread::Listed,
) -> Result<String, Error> {
    let id = thread::name(&found.place);
    let row = store.get(&workspace.name, id).await?;
    if let Some(repo) = row.and_then(|row| row.repo) {
        return Ok(repo);
    }
    let path = workspace.repo.to_string_lossy();
    let repo = match store.cloned(&workspace.machine, &path).await? {
        Some(repo) => repo,
        None => commit::repository(found)?,
    };
    Ok(store
        .bind(
            &workspace.name,
            id,
            &workspace.machine,
            &found.place.branch,
            &found.place.worktree,
            &repo,
        )
        .await?)
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::store::tests::{live, place, scratch};
    use std::sync::Mutex;
    use yantra_core::github::{Github, Token};
    use yantra_core::ssh;

    /// A machine that answers each command in turn and counts them.
    struct Machine(Mutex<Vec<ssh::Output>>);

    impl Machine {
        fn answering(replies: &[(i32, &str)]) -> Self {
            Self(Mutex::new(
                replies
                    .iter()
                    .map(|(status, stdout)| ssh::Output {
                        status: *status,
                        stdout: stdout.as_bytes().to_vec(),
                        stderr: Vec::new(),
                    })
                    .collect(),
            ))
        }

        fn left(&self) -> usize {
            self.0.lock().expect("the replies").len()
        }
    }

    impl Exec for Machine {
        async fn exec(&self, _: &str) -> Result<ssh::Output, ssh::Error> {
            Ok(self.0.lock().expect("the replies").remove(0))
        }
    }

    fn workspace() -> Workspace {
        Workspace {
            name: "web".to_owned(),
            machine: "m".to_owned(),
            repo: "~/src/r".into(),
            startup: None,
        }
    }

    fn listed(id: &str, remote: &str) -> thread::Listed {
        thread::Listed {
            place: place(id),
            title: None,
            from: None,
            issue: None,
            upstream: Some((remote.to_owned(), format!("yantra/{id}"))),
            kept: thread::Kept::default(),
        }
    }

    fn opened(id: &str) -> thread::Opened {
        let at = place(id);
        thread::Opened {
            thread: id.to_owned(),
            branch: at.branch,
            worktree: at.worktree,
            issue: "o/r#7".to_owned(),
            draft: String::new(),
        }
    }

    /// The done condition's second half: a row from before Y-782 binds on its
    /// first PR verb and only then. The rewritten remote does not move it, and
    /// the verb refuses.
    #[tokio::test]
    async fn an_old_row_binds_on_first_use_and_only_once() {
        let (store, _) = scratch();
        store
            .adopt(vec![live("a", Some("old"), Some("S"))])
            .await
            .expect("adopted");
        let moved = listed("a", "https://github.com/evil/x.git");

        let first = bound(&store, &workspace(), &listed("a", "git@github.com:o/r.git")).await;
        let second = bound(&store, &workspace(), &moved).await;

        assert_eq!(first.expect("bound"), "o/r");
        let held = second.expect("the first binding");
        assert_eq!(held, "o/r");
        let github = Github::at("http://127.0.0.1:9", "http://127.0.0.1:9");
        let token = Token::new("gho_notarealtoken".to_owned());
        assert!(matches!(
            commit::pending_pr(&moved, &github, &token, Some(&held)).await,
            Err(commit::Failed::OtherRepository { bound, remote })
                if bound == "o/r" && remote == "evil/x"
        ));
    }

    #[tokio::test]
    async fn a_thread_with_no_row_and_no_upstream_binds_nothing() {
        let (store, _) = scratch();
        let mut unpushed = listed("a", "");
        unpushed.upstream = None;

        let refused = bound(&store, &workspace(), &unpushed).await;

        assert!(matches!(
            refused,
            Err(Error::Commit(commit::Failed::NotPushed))
        ));
        assert_eq!(store.get("web", "a").await.expect("a read"), None);
    }

    /// The 2026-11-23 note: the record of Yantra's own clone wins over the
    /// remote, for an old row and for a new thread, and the machine is not asked.
    #[tokio::test]
    async fn a_clone_record_wins_over_the_remote() {
        let (store, _) = scratch();
        store.put_clone("m", "~/src/r", "o/r").await.expect("kept");
        let machine = Machine::answering(&[(0, "https://github.com/evil/x.git\n")]);

        let old = bound(
            &store,
            &workspace(),
            &listed("a", "https://github.com/evil/x.git"),
        )
        .await;
        created(&store, &workspace(), &machine, &opened("b")).await;

        assert_eq!(old.expect("bound"), "o/r");
        let new = store.get("web", "b").await.expect("a read").expect("a row");
        assert_eq!(new.repo.as_deref(), Some("o/r"));
        assert_eq!(machine.left(), 1, "the remote was not read");
    }

    /// A folder Yantra did not clone: the thread takes `origin` as it is
    /// before the agent runs, and a later rewrite does not move it.
    #[tokio::test]
    async fn a_new_thread_with_no_clone_record_takes_the_remote_at_creation() {
        let (store, _) = scratch();
        let machine = Machine::answering(&[(0, "git@github.com:o/r.git\n")]);

        created(&store, &workspace(), &machine, &opened("a")).await;

        let row = store.get("web", "a").await.expect("a read").expect("a row");
        assert_eq!(
            (
                row.repo.as_deref(),
                row.branch.as_str(),
                row.machine.as_str()
            ),
            (Some("o/r"), place("a").branch.as_str(), "m")
        );
        let later = bound(
            &store,
            &workspace(),
            &listed("a", "https://github.com/evil/x.git"),
        )
        .await;
        assert_eq!(later.expect("the binding"), "o/r");
    }

    /// No `origin`, an `origin` that is not on github.com, and a git that
    /// failed all leave the thread unbound.
    #[tokio::test]
    async fn a_folder_with_no_github_origin_leaves_the_thread_unbound() {
        let (store, _) = scratch();
        let machine =
            Machine::answering(&[(1, ""), (0, "https://gitlab.com/o/r.git\n"), (128, "")]);

        for _ in 0..3 {
            created(&store, &workspace(), &machine, &opened("a")).await;
        }

        assert_eq!(machine.left(), 0);
        assert_eq!(store.get("web", "a").await.expect("a read"), None);
    }
}
