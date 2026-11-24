//! The thread store ([ADR-0045]): one SQLite file on the hub, one row per Chat
//! thread, and no message text and no secret. Since [ADR-0047] it also holds
//! one row per device that gets Web Push.
//!
//! Hand-written SQL and no ORM (I-14). Every connection sets the pragmas
//! [`open`] names (I-12), and every call runs on a blocking thread (I-13).
//!
//! [ADR-0045]: ../../../docs/adr/0045-the-hub-keeps-a-thread-store.md
//! [ADR-0047]: ../../../docs/adr/0047-the-dashboard-gets-web-push.md

use std::fs::{DirBuilder, OpenOptions, Permissions};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::{Connection, OptionalExtension, params};
use yantra_core::thread::Place;

/// A title longer than this is cut (ADR-0045 decision 2).
const TITLE: usize = 80;

/// The most rows a search returns.
const FOUND: usize = 20;

/// Run in order under `PRAGMA user_version`. Append; never edit one that shipped.
const MIGRATIONS: &[&str] = &[
    "CREATE TABLE threads (
        workspace TEXT NOT NULL,
        id TEXT NOT NULL,
        machine TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        worktree TEXT NOT NULL DEFAULT '',
        harness TEXT,
        session TEXT,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'idle'
            CHECK (status IN ('running', 'waiting', 'idle', 'ended', 'gone')),
        created INTEGER NOT NULL,
        active INTEGER NOT NULL,
        seen INTEGER,
        tasks TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (workspace, id)
    ) STRICT",
    "CREATE TABLE push_devices (
        endpoint TEXT PRIMARY KEY NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created INTEGER NOT NULL
    ) STRICT",
    "ALTER TABLE threads ADD COLUMN repo TEXT;
    CREATE TABLE clones (
        machine TEXT NOT NULL,
        path TEXT NOT NULL,
        repo TEXT NOT NULL,
        created INTEGER NOT NULL,
        PRIMARY KEY (machine, path)
    ) STRICT",
];

const COLUMNS: &str = "workspace, id, machine, branch, worktree, harness, session, title, status, created, active, seen, repo";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not prepare the thread store {}", path.display())]
    Prepare {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("the thread store failed")]
    Sql(#[from] rusqlite::Error),

    #[error("a thread store call did not finish")]
    Join(#[from] tokio::task::JoinError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Running,
    Waiting,
    Idle,
    Ended,
    /// The machine answered without the thread's worktree (decision 4).
    Gone,
}

impl Status {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Idle => "idle",
            Self::Ended => "ended",
            Self::Gone => "gone",
        }
    }

    fn named(name: &str) -> Self {
        match name {
            "running" => Self::Running,
            "waiting" => Self::Waiting,
            "ended" => Self::Ended,
            "gone" => Self::Gone,
            _ => Self::Idle,
        }
    }
}

/// One thread. Times are Unix milliseconds. An empty workspace, branch or
/// worktree is a home thread's (Y-698).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub workspace: String,
    pub id: String,
    pub machine: String,
    pub branch: String,
    pub worktree: String,
    pub harness: Option<String>,
    pub session: Option<String>,
    pub title: Option<String>,
    pub status: Status,
    pub created: i64,
    pub active: i64,
    /// The last time the machine answered.
    pub seen: Option<i64>,
    /// The GitHub repository the thread's PR verbs may write, `owner/repo`.
    /// Only [`Store::bind`] writes it (Y-782).
    pub repo: Option<String>,
}

/// One device's Web Push subscription, as its browser gave it (ADR-0047
/// decision 3). The endpoint is a capability, so `Debug` prints no field.
#[derive(Clone, PartialEq, Eq)]
pub struct Device {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

impl std::fmt::Debug for Device {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Device").finish_non_exhaustive()
    }
}

fn device(at: &rusqlite::Row<'_>) -> rusqlite::Result<Device> {
    Ok(Device {
        endpoint: at.get(0)?,
        p256dh: at.get(1)?,
        auth: at.get(2)?,
    })
}

fn row(at: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        workspace: at.get(0)?,
        id: at.get(1)?,
        machine: at.get(2)?,
        branch: at.get(3)?,
        worktree: at.get(4)?,
        harness: at.get(5)?,
        session: at.get(6)?,
        title: at.get(7)?,
        status: Status::named(&at.get::<_, String>(8)?),
        created: at.get(9)?,
        active: at.get(10)?,
        seen: at.get(11)?,
        repo: at.get(12)?,
    })
}

pub fn now() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

fn cut(title: &str) -> String {
    title.chars().take(TITLE).collect()
}

/// `$XDG_STATE_HOME/yantra/threads.sqlite` (decision 1).
pub fn path() -> Option<PathBuf> {
    use etcetera::BaseStrategy as _;
    let base = etcetera::choose_base_strategy().ok()?;
    Some(base.state_dir()?.join("yantra").join("threads.sqlite"))
}

#[derive(Clone)]
pub struct Store(Arc<Mutex<Connection>>);

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

/// Opens the store at `path`, its directory `0700` and the file `0600`, and
/// runs the migrations it has not run.
pub fn open(path: &Path) -> Result<Store, Error> {
    let prepare = |source| Error::Prepare {
        path: path.to_owned(),
        source,
    };
    if let Some(dir) = path.parent() {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(prepare)?;
        std::fs::set_permissions(dir, Permissions::from_mode(0o700)).map_err(prepare)?;
    }
    // Made before SQLite opens it, so it is never readable by another account.
    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .map_err(prepare)?;
    std::fs::set_permissions(path, Permissions::from_mode(0o600)).map_err(prepare)?;
    let mut connection = Connection::open(path)?;
    connection.execute_batch(
        "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
    )?;
    migrate(&mut connection)?;
    Ok(Store(Arc::new(Mutex::new(connection))))
}

fn migrate(connection: &mut Connection) -> rusqlite::Result<()> {
    let ran: u32 = connection.query_row("PRAGMA user_version", [], |at| at.get(0))?;
    for (version, migration) in (1u32..).zip(MIGRATIONS).skip(ran as usize) {
        let tx = connection.transaction()?;
        tx.execute_batch(migration)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}

impl Store {
    async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> Result<T, Error> {
        let connection = Arc::clone(&self.0);
        let done = tokio::task::spawn_blocking(move || {
            f(&mut connection.lock().unwrap_or_else(PoisonError::into_inner))
        })
        .await?;
        Ok(done?)
    }

    /// Keeps `device`, or replaces its keys. `false` when the store already
    /// holds `limit` other devices.
    pub async fn put_device(&self, device: Device, limit: usize) -> Result<bool, Error> {
        self.call(move |db| {
            let tx = db.transaction()?;
            let others: i64 = tx.query_row(
                "SELECT COUNT(*) FROM push_devices WHERE endpoint != ?1",
                params![device.endpoint],
                |at| at.get(0),
            )?;
            if others >= limit as i64 {
                return Ok(false);
            }
            tx.execute(
                "INSERT INTO push_devices (endpoint, p256dh, auth, created) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth",
                params![device.endpoint, device.p256dh, device.auth, now()],
            )?;
            tx.commit()?;
            Ok(true)
        })
        .await
    }

    /// `false` when the store held no such device.
    pub async fn remove_device(&self, endpoint: &str) -> Result<bool, Error> {
        let endpoint = endpoint.to_owned();
        self.call(move |db| {
            db.execute(
                "DELETE FROM push_devices WHERE endpoint = ?1",
                params![endpoint],
            )
            .map(|removed| removed > 0)
        })
        .await
    }

    /// Removes every device: a new signing key cannot push to them.
    pub async fn remove_devices(&self) -> Result<(), Error> {
        self.call(|db| db.execute("DELETE FROM push_devices", []).map(drop))
            .await
    }

    pub async fn device(&self, endpoint: &str) -> Result<Option<Device>, Error> {
        let endpoint = endpoint.to_owned();
        self.call(move |db| {
            db.query_row(
                "SELECT endpoint, p256dh, auth FROM push_devices WHERE endpoint = ?1",
                params![endpoint],
                device,
            )
            .optional()
        })
        .await
    }

    pub async fn devices(&self) -> Result<Vec<Device>, Error> {
        self.call(|db| {
            db.prepare("SELECT endpoint, p256dh, auth FROM push_devices ORDER BY created")?
                .query_map([], device)?
                .collect()
        })
        .await
    }

    /// Keeps the session a keeper read from its harness (decision 3).
    pub async fn put_session(
        &self,
        workspace: &str,
        id: &str,
        machine: &str,
        place: &Place,
        harness: &str,
        session: &str,
    ) -> Result<(), Error> {
        let values = (
            workspace.to_owned(),
            id.to_owned(),
            machine.to_owned(),
            place.branch.clone(),
            place.worktree.clone(),
            harness.to_owned(),
            session.to_owned(),
        );
        self.call(move |db| {
            db.execute(
                "INSERT INTO threads (workspace, id, machine, branch, worktree, harness, session, created, active)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                 ON CONFLICT (workspace, id) DO UPDATE SET machine = excluded.machine,
                     branch = excluded.branch, worktree = excluded.worktree,
                     harness = excluded.harness, session = excluded.session, active = excluded.active",
                params![values.0, values.1, values.2, values.3, values.4, values.5, values.6, now()],
            )
            .map(drop)
        })
        .await
    }

    /// The harness and session id of thread `id`, when the store has both.
    pub async fn session(
        &self,
        workspace: &str,
        id: &str,
    ) -> Result<Option<(String, String)>, Error> {
        let (workspace, id) = (workspace.to_owned(), id.to_owned());
        self.call(move |db| {
            db.query_row(
                "SELECT harness, session FROM threads WHERE workspace = ?1 AND id = ?2
                 AND harness IS NOT NULL AND session IS NOT NULL",
                params![workspace, id],
                |at| Ok((at.get(0)?, at.get(1)?)),
            )
            .optional()
        })
        .await
    }

    /// Keeps the thread's title, cut at 80 characters.
    pub async fn put_title(
        &self,
        workspace: &str,
        id: &str,
        machine: &str,
        place: &Place,
        title: &str,
    ) -> Result<(), Error> {
        let values = (
            workspace.to_owned(),
            id.to_owned(),
            machine.to_owned(),
            place.branch.clone(),
            place.worktree.clone(),
            cut(title),
        );
        self.call(move |db| {
            db.execute(
                "INSERT INTO threads (workspace, id, machine, branch, worktree, title, created, active)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT (workspace, id) DO UPDATE SET title = excluded.title",
                params![values.0, values.1, values.2, values.3, values.4, values.5, now()],
            )
            .map(drop)
        })
        .await
    }

    /// Inserts each row the store does not have, and never overwrites one
    /// (decision 6). A row that only [`Store::bind`] made holds no harness, no
    /// session and no title, so it takes those three. A row's repository is
    /// never written here.
    pub async fn adopt(&self, rows: Vec<Row>) -> Result<(), Error> {
        self.call(move |db| {
            let tx = db.transaction()?;
            for row in rows {
                tx.execute(
                    "INSERT INTO threads (workspace, id, machine, branch, worktree, harness, session, title, status, created, active, seen)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                     ON CONFLICT (workspace, id) DO UPDATE SET harness = excluded.harness,
                         session = excluded.session, title = excluded.title
                     WHERE threads.harness IS NULL AND threads.session IS NULL AND threads.title IS NULL",
                    params![
                        row.workspace,
                        row.id,
                        row.machine,
                        row.branch,
                        row.worktree,
                        row.harness,
                        row.session,
                        row.title.as_deref().map(cut),
                        row.status.name(),
                        row.created,
                        row.active,
                        row.seen,
                    ],
                )?;
            }
            tx.commit()
        })
        .await
    }

    /// What `machine` answered for `workspace`: each live thread's status,
    /// branch and worktree, and `gone` for each of its rows it did not name
    /// (decision 4).
    pub async fn observe(
        &self,
        workspace: &str,
        machine: &str,
        live: Vec<Row>,
    ) -> Result<(), Error> {
        let (workspace, machine) = (workspace.to_owned(), machine.to_owned());
        self.call(move |db| {
            let seen = now();
            let tx = db.transaction()?;
            for row in &live {
                tx.execute(
                    "UPDATE threads SET status = ?3, branch = ?4, worktree = ?5, seen = ?6
                     WHERE workspace = ?1 AND id = ?2",
                    params![workspace, row.id, row.status.name(), row.branch, row.worktree, seen],
                )?;
            }
            let ids: Vec<&str> = live.iter().map(|row| row.id.as_str()).collect();
            tx.execute(
                "UPDATE threads SET status = 'gone', seen = ?3
                 WHERE workspace = ?1 AND machine = ?2 AND id NOT IN (SELECT value FROM json_each(?4))",
                params![workspace, machine, seen, serde_json::json!(ids).to_string()],
            )?;
            tx.commit()
        })
        .await
    }

    /// Every row of `workspace`, the newest first.
    pub async fn list(&self, workspace: &str) -> Result<Vec<Row>, Error> {
        let workspace = workspace.to_owned();
        self.call(move |db| {
            db.prepare(&format!(
                "SELECT {COLUMNS} FROM threads WHERE workspace = ?1 ORDER BY created DESC, id"
            ))?
            .query_map(params![workspace], row)?
            .collect()
        })
        .await
    }

    /// Every row of `machine`, home threads among them, the newest first
    /// (ADR-0046 decision 1.7).
    pub async fn list_machine(&self, machine: &str) -> Result<Vec<Row>, Error> {
        let machine = machine.to_owned();
        self.call(move |db| {
            db.prepare(&format!(
                "SELECT {COLUMNS} FROM threads WHERE machine = ?1 ORDER BY created DESC, id"
            ))?
            .query_map(params![machine], row)?
            .collect()
        })
        .await
    }

    /// Threads of any workspace whose title holds `text`, newest activity first,
    /// at most [`FOUND`]. Home rows are left out until `/w/$name` can open them (Y-699).
    pub async fn search(&self, text: &str) -> Result<Vec<Row>, Error> {
        let like = text
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        self.call(move |db| {
            db.prepare(&format!(
                "SELECT {COLUMNS} FROM threads
                 WHERE workspace <> '' AND title LIKE '%' || ?1 || '%' ESCAPE '\\'
                 ORDER BY active DESC, id LIMIT {FOUND}"
            ))?
            .query_map(params![like], row)?
            .collect()
        })
        .await
    }

    /// Thread `id` of `workspace`, when the store has it.
    pub async fn get(&self, workspace: &str, id: &str) -> Result<Option<Row>, Error> {
        let (workspace, id) = (workspace.to_owned(), id.to_owned());
        self.call(move |db| {
            db.query_row(
                &format!("SELECT {COLUMNS} FROM threads WHERE workspace = ?1 AND id = ?2"),
                params![workspace, id],
                row,
            )
            .optional()
        })
        .await
    }

    /// Binds thread `id` to the GitHub repository `repo` when its row has
    /// none, and answers the repository the row holds, so the first binding
    /// wins (ADR-0045, 2026-11-12 note). No other statement writes it.
    pub async fn bind(
        &self,
        workspace: &str,
        id: &str,
        machine: &str,
        branch: &str,
        worktree: &str,
        repo: &str,
    ) -> Result<String, Error> {
        let values = (
            workspace.to_owned(),
            id.to_owned(),
            machine.to_owned(),
            branch.to_owned(),
            worktree.to_owned(),
            repo.to_owned(),
        );
        self.call(move |db| {
            let tx = db.transaction()?;
            tx.execute(
                "INSERT INTO threads (workspace, id, machine, branch, worktree, repo, created, active)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT (workspace, id) DO UPDATE SET repo = excluded.repo
                 WHERE threads.repo IS NULL",
                params![values.0, values.1, values.2, values.3, values.4, values.5, now()],
            )?;
            let held = tx.query_row(
                "SELECT repo FROM threads WHERE workspace = ?1 AND id = ?2",
                params![values.0, values.1],
                |at| at.get(0),
            )?;
            tx.commit()?;
            Ok(held)
        })
        .await
    }

    /// Records that Yantra cloned `repo` into `path` on `machine` (ADR-0045,
    /// 2026-11-23 note). A later clone of the path replaces the record.
    pub async fn put_clone(&self, machine: &str, path: &str, repo: &str) -> Result<(), Error> {
        let values = (machine.to_owned(), path.to_owned(), repo.to_owned());
        self.call(move |db| {
            db.execute(
                "INSERT INTO clones (machine, path, repo, created) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (machine, path) DO UPDATE SET repo = excluded.repo,
                     created = excluded.created",
                params![values.0, values.1, values.2, now()],
            )
            .map(drop)
        })
        .await
    }

    /// The repository Yantra cloned into `path` on `machine`, as the owner
    /// typed both.
    pub async fn cloned(&self, machine: &str, path: &str) -> Result<Option<String>, Error> {
        let (machine, path) = (machine.to_owned(), path.to_owned());
        self.call(move |db| {
            db.query_row(
                "SELECT repo FROM clones WHERE machine = ?1 AND path = ?2",
                params![machine, path],
                |at| at.get(0),
            )
            .optional()
        })
        .await
    }

    /// Forgets a thread the daemon removed. `false` is a row it did not have.
    pub async fn remove(&self, workspace: &str, id: &str) -> Result<bool, Error> {
        let (workspace, id) = (workspace.to_owned(), id.to_owned());
        self.call(move |db| {
            db.execute(
                "DELETE FROM threads WHERE workspace = ?1 AND id = ?2",
                params![workspace, id],
            )
            .map(|gone| gone > 0)
        })
        .await
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A store in a directory of its own under the system temp dir.
    pub(crate) fn scratch() -> (Store, PathBuf) {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "yantra-store-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("yantra").join("threads.sqlite");
        (open(&path).expect("a store"), path)
    }

    pub(crate) fn place(id: &str) -> Place {
        Place {
            id: format!("chat/web/{id}"),
            repo: "/home/u/repo".to_owned(),
            worktree: format!("/home/u/.yantra/worktrees/chat/web/{id}"),
            branch: format!("yantra/chat/web/{id}"),
            base: "0123abcd".to_owned(),
        }
    }

    pub(crate) fn live(id: &str, title: Option<&str>, session: Option<&str>) -> Row {
        let place = place(id);
        Row {
            workspace: "web".to_owned(),
            id: id.to_owned(),
            machine: "m".to_owned(),
            branch: place.branch,
            worktree: place.worktree,
            harness: Some("claude".to_owned()),
            session: session.map(str::to_owned),
            title: title.map(str::to_owned),
            status: Status::Idle,
            created: 1,
            active: 1,
            seen: Some(1),
            repo: None,
        }
    }

    #[tokio::test]
    async fn every_connection_sets_the_busy_timeout_and_wal() {
        let (store, _) = scratch();
        let (busy, journal, synchronous) = store
            .call(|db| {
                Ok((
                    db.query_row("PRAGMA busy_timeout", [], |at| at.get::<_, i64>(0))?,
                    db.query_row("PRAGMA journal_mode", [], |at| at.get::<_, String>(0))?,
                    db.query_row("PRAGMA synchronous", [], |at| at.get::<_, i64>(0))?,
                ))
            })
            .await
            .expect("pragmas");
        assert_eq!((busy, journal.as_str(), synchronous), (5000, "wal", 1));
    }

    #[tokio::test]
    async fn migrations_run_twice_without_harm() {
        let (store, path) = scratch();
        store
            .put_title("web", "a", "m", &place("a"), "kept")
            .await
            .expect("a title");
        drop(store);

        let again = open(&path).expect("a second open");
        let version: u32 = again
            .call(|db| db.query_row("PRAGMA user_version", [], |at| at.get(0)))
            .await
            .expect("a version");
        assert_eq!(version as usize, MIGRATIONS.len());
        let rows = again.list("web").await.expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title.as_deref(), Some("kept"));
    }

    #[tokio::test]
    async fn adopt_never_overwrites_a_row() {
        let (store, _) = scratch();
        store
            .put_session("web", "a", "m", &place("a"), "claude", "A")
            .await
            .expect("a session");

        store
            .adopt(vec![
                live("a", Some("from git"), Some("B")),
                live("b", None, Some("C")),
            ])
            .await
            .expect("adopted");

        assert_eq!(
            store.session("web", "a").await.expect("a read"),
            Some(("claude".to_owned(), "A".to_owned()))
        );
        assert_eq!(
            store.session("web", "b").await.expect("a read"),
            Some(("claude".to_owned(), "C".to_owned()))
        );
        let rows = store.list("web").await.expect("rows");
        assert_eq!(rows.iter().find(|row| row.id == "a").unwrap().title, None);
    }

    #[tokio::test]
    async fn a_thread_the_machine_no_longer_has_is_gone_and_keeps_its_title() {
        let (store, _) = scratch();
        store
            .adopt(vec![
                live("a", Some("first"), Some("A")),
                live("b", Some("second"), None),
            ])
            .await
            .expect("adopted");
        let mut running = live("b", None, None);
        running.status = Status::Running;
        running.worktree = "/elsewhere".to_owned();

        store
            .observe("web", "m", vec![running])
            .await
            .expect("observed");

        let rows = store.list("web").await.expect("rows");
        let a = rows.iter().find(|row| row.id == "a").unwrap();
        assert_eq!(
            (a.status, a.title.as_deref()),
            (Status::Gone, Some("first"))
        );
        assert!(a.seen.unwrap() > 1, "the machine answered");
        let b = rows.iter().find(|row| row.id == "b").unwrap();
        assert_eq!(
            (b.status, b.worktree.as_str()),
            (Status::Running, "/elsewhere")
        );
    }

    #[tokio::test]
    async fn another_machines_rows_are_not_marked_gone() {
        let (store, _) = scratch();
        let mut elsewhere = live("a", None, None);
        elsewhere.machine = "mac".to_owned();
        store.adopt(vec![elsewhere]).await.expect("adopted");

        store.observe("web", "m", vec![]).await.expect("observed");

        assert_eq!(
            store.list("web").await.expect("rows")[0].status,
            Status::Idle
        );
    }

    #[tokio::test]
    async fn the_file_is_0600_in_a_0700_directory() {
        let (_store, path) = scratch();
        let mode = |path: &Path| {
            std::fs::metadata(path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().expect("a directory")), 0o700);
    }

    #[tokio::test]
    async fn a_title_is_cut_at_80_characters() {
        let (store, _) = scratch();
        let long = "é".repeat(100);

        store
            .put_title("web", "a", "m", &place("a"), &long)
            .await
            .expect("a title");

        let title = store.list("web").await.expect("rows")[0]
            .title
            .clone()
            .unwrap();
        assert_eq!(title.chars().count(), 80);
    }

    /// Decision 2: the title is the only conversation text in the file.
    #[tokio::test]
    async fn the_store_holds_no_text_beyond_the_title() {
        let (store, path) = scratch();
        let prompt = format!("{} SECRET-PAST-THE-CUT", "word ".repeat(16));

        store
            .put_title("web", "a", "m", &place("a"), &prompt)
            .await
            .expect("a title");
        store
            .put_session("web", "a", "m", &place("a"), "claude", "S")
            .await
            .expect("a session");

        let mut bytes = std::fs::read(&path).expect("the file");
        bytes.extend(std::fs::read(path.with_extension("sqlite-wal")).unwrap_or_default());
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("word word"), "the title is there");
        assert!(!text.contains("SECRET-PAST-THE-CUT"));
    }

    /// Y-782: a file from before the repository column opens, keeps its rows
    /// and gains the clone table.
    #[tokio::test]
    async fn a_version_1_file_migrates_and_its_rows_have_no_repository() {
        let (store, path) = scratch();
        drop(store);
        std::fs::remove_file(&path).expect("the file goes");
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
        let old = Connection::open(&path).expect("a version 1 file");
        old.execute_batch(MIGRATIONS[0]).expect("the first schema");
        old.pragma_update(None, "user_version", 1)
            .expect("version 1");
        old.execute(
            "INSERT INTO threads (workspace, id, machine, title, created, active)
             VALUES ('web', 'a', 'm', 'kept', 1, 1)",
            [],
        )
        .expect("an old row");
        drop(old);

        let store = open(&path).expect("the migration runs");

        let rows = store.list("web").await.expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (rows[0].title.as_deref(), rows[0].repo.as_deref()),
            (Some("kept"), None)
        );
        assert_eq!(store.cloned("m", "~/src/r").await.expect("a read"), None);
    }

    /// Y-782: the first binding wins, for a row that was there and for one that was not.
    #[tokio::test]
    async fn bind_keeps_the_first_repository() {
        let (store, _) = scratch();
        store
            .adopt(vec![live("old", Some("an old thread"), Some("S"))])
            .await
            .expect("adopted");

        for id in ["old", "new"] {
            let at = place(id);
            let bind = |repo| store.bind("web", id, "m", &at.branch, &at.worktree, repo);
            let first = bind("o/r").await;
            let second = bind("evil/x").await;
            assert_eq!(first.expect("bound"), "o/r");
            assert_eq!(second.expect("the first one"), "o/r");
        }

        let rows = store.list("web").await.expect("rows");
        assert!(rows.iter().all(|row| row.repo.as_deref() == Some("o/r")));
        let old = rows.iter().find(|row| row.id == "old").unwrap();
        assert_eq!(
            (old.title.as_deref(), old.session.as_deref()),
            (Some("an old thread"), Some("S"))
        );
        let new = rows.iter().find(|row| row.id == "new").unwrap();
        assert_eq!(new.branch, place("new").branch);
    }

    /// No other write reaches the repository, and a row that only `bind` made
    /// still takes what git config keeps.
    #[tokio::test]
    async fn only_bind_writes_the_repository() {
        let (store, _) = scratch();
        let bind = async |id| {
            let at = place(id);
            let bound = store.bind("web", id, "m", &at.branch, &at.worktree, "o/r");
            bound.await.expect("bound");
        };
        bind("a").await;
        let mut claimed = live("a", Some("#7 Fix it"), Some("S"));
        claimed.repo = Some("evil/x".to_owned());

        store.adopt(vec![claimed.clone()]).await.expect("adopted");
        store
            .put_title("web", "a", "m", &place("a"), "renamed")
            .await
            .expect("a title");
        store
            .put_session("web", "a", "m", &place("a"), "codex", "T")
            .await
            .expect("a session");
        store
            .observe("web", "m", vec![claimed])
            .await
            .expect("observed");

        let row = store.get("web", "a").await.expect("a read").expect("a row");
        assert_eq!(row.repo.as_deref(), Some("o/r"));
        assert_eq!(row.title.as_deref(), Some("renamed"));

        bind("b").await;
        store
            .adopt(vec![live("b", Some("#7 Fix it"), Some("S"))])
            .await
            .expect("adopted");
        let row = store.get("web", "b").await.expect("a read").expect("a row");
        assert_eq!(
            (
                row.title.as_deref(),
                row.harness.as_deref(),
                row.repo.as_deref()
            ),
            (Some("#7 Fix it"), Some("claude"), Some("o/r"))
        );
    }

    #[tokio::test]
    async fn a_later_clone_of_a_path_replaces_its_record() {
        let (store, _) = scratch();
        store.put_clone("m", "~/src/r", "o/r").await.expect("kept");
        store
            .put_clone("mac", "~/src/r", "o/mac")
            .await
            .expect("kept");

        store
            .put_clone("m", "~/src/r", "o/fork")
            .await
            .expect("kept");

        let cloned = async |machine: &'static str, path: &'static str| {
            store.cloned(machine, path).await.expect("a read")
        };
        assert_eq!(cloned("m", "~/src/r").await.as_deref(), Some("o/fork"));
        assert_eq!(cloned("mac", "~/src/r").await.as_deref(), Some("o/mac"));
        assert_eq!(cloned("m", "~/src/other").await, None);
    }

    /// ADR-0046 decision 1.4: a home row has no workspace, branch or worktree.
    fn home(id: &str, machine: &str, created: i64) -> Row {
        Row {
            workspace: String::new(),
            branch: String::new(),
            worktree: String::new(),
            machine: machine.to_owned(),
            created,
            ..live(id, Some("hello"), None)
        }
    }

    #[tokio::test]
    async fn a_machines_rows_list_newest_first_with_its_home_threads() {
        let (store, _) = scratch();
        let mut elsewhere = live("c", None, None);
        elsewhere.machine = "mac".to_owned();
        store
            .adopt(vec![
                live("a", None, None),
                home("h", "m", 2),
                elsewhere,
                home("x", "mac", 3),
            ])
            .await
            .expect("adopted");

        let rows = store.list_machine("m").await.expect("rows");

        assert_eq!(
            rows.iter()
                .map(|row| (row.workspace.as_str(), row.id.as_str()))
                .collect::<Vec<_>>(),
            [("", "h"), ("web", "a")]
        );
        assert!(
            store
                .list("web")
                .await
                .expect("rows")
                .iter()
                .all(|row| row.id != "h")
        );
    }

    #[tokio::test]
    async fn get_reads_one_row_by_its_key() {
        let (store, _) = scratch();
        store.adopt(vec![home("h", "m", 1)]).await.expect("adopted");

        let row = store.get("", "h").await.expect("a read").expect("the row");
        assert_eq!(
            (row.machine.as_str(), row.title.as_deref()),
            ("m", Some("hello"))
        );
        assert_eq!(store.get("web", "h").await.expect("a read"), None);
    }

    #[tokio::test]
    async fn remove_forgets_only_the_thread_named() {
        let (store, _) = scratch();
        store
            .adopt(vec![live("a", None, None), live("b", None, None)])
            .await
            .expect("adopted");

        assert!(store.remove("web", "a").await.expect("removed"));
        assert!(!store.remove("web", "a").await.expect("removed"));

        let rows = store.list("web").await.expect("rows");
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["b"]
        );
    }

    async fn kept(store: &Store, workspace: &str, id: &str, title: &str, active: i64) {
        let mut one = live(id, Some(title), None);
        one.workspace = workspace.to_owned();
        one.active = active;
        store.adopt(vec![one]).await.expect("adopted");
    }

    #[tokio::test]
    async fn search_matches_a_title_in_any_case_across_workspaces() {
        let (store, _) = scratch();
        kept(&store, "web", "a", "Fix the Login form", 1).await;
        kept(&store, "api", "b", "Add a store", 2).await;
        let found = store.search("LOGIN").await.expect("rows");
        assert_eq!(found.len(), 1);
        assert_eq!(
            (found[0].workspace.as_str(), found[0].id.as_str()),
            ("web", "a")
        );
    }

    #[tokio::test]
    async fn search_reads_percent_underscore_and_backslash_literally() {
        let (store, _) = scratch();
        kept(&store, "web", "a", "Cut 50% of the cost", 1).await;
        kept(&store, "web", "b", "Cut 50 of the cost", 2).await;
        kept(&store, "web", "c", "snake_case names", 3).await;
        kept(&store, "web", "d", "snakeXcase names", 4).await;
        kept(&store, "web", "e", "path a\\b", 5).await;
        let ids = |rows: Vec<Row>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(store.search("%").await.unwrap()), ["a"]);
        assert_eq!(ids(store.search("e_c").await.unwrap()), ["c"]);
        assert_eq!(ids(store.search("a\\b").await.unwrap()), ["e"]);
    }

    #[tokio::test]
    async fn search_skips_home_rows_and_orders_by_activity() {
        let (store, _) = scratch();
        kept(&store, "", "h", "home thread", 9).await;
        kept(&store, "web", "a", "old thread", 1).await;
        kept(&store, "web", "b", "new thread", 5).await;
        let found = store.search("thread").await.expect("rows");
        let ids: Vec<_> = found.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
    }

    #[tokio::test]
    async fn search_with_no_text_returns_the_newest_twenty() {
        let (store, _) = scratch();
        for n in 0..25 {
            kept(&store, "web", &format!("t{n:02}"), "a thread", n).await;
        }
        let found = store.search("").await.expect("rows");
        assert_eq!(found.len(), 20);
        assert_eq!(found[0].id, "t24");
    }
}
