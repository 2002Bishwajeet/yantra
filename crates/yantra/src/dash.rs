//! `yantra dash --daemon <url> [--view-only]`: the fleet in a terminal (Y-592).
//!
//! It reads what the web dashboard reads, from the same routes, and attaches
//! through `ssh` and tmux as `yantra attach` does. It adds no multiplexer (§B2).
//! As in `why.rs`, the structs below read only the fields the screen draws
//! (ADR-0012 keeps the daemon's DTOs out of core).

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use ratatui::crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind};
use ratatui::crossterm::{execute, terminal};
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style, Stylize as _};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph, Row, Table, TableState};
use ratatui::{DefaultTerminal, Frame};
use serde::Deserialize;
use yantra_core::attach;
use yantra_core::terminfo::Chosen;

const POLL: Duration = Duration::from_secs(2);
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not reach yantrad at {daemon}: {detail}")]
    Unreachable { daemon: String, detail: String },
    #[error("yantrad at {daemon} sent an unreadable answer to {path}: {detail}")]
    Unreadable {
        daemon: String,
        path: String,
        detail: String,
    },
}

/// `yantrad`'s envelope. I-47: `never` and `failed` are not an empty list.
#[derive(Debug, Deserialize)]
#[serde(tag = "looked", rename_all = "lowercase")]
pub enum Answer<T> {
    Ok { age_seconds: u64, data: T },
    Failed { error: String },
    Never,
}

#[derive(Debug, Deserialize)]
pub struct Machine {
    name: String,
    online: bool,
    expired: bool,
    heartbeat: Option<Beat>,
}

#[derive(Debug, Deserialize)]
struct Beat {
    age_seconds: u64,
}

#[derive(Debug, Deserialize)]
pub struct Listed {
    name: String,
    #[serde(flatten)]
    loaded: Loaded,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "loaded", rename_all = "lowercase")]
enum Loaded {
    Yes { machine: String },
    No { error: String },
}

#[derive(Debug, Deserialize)]
pub struct MachineSessions {
    machine: String,
    #[serde(flatten)]
    reached: Reached<Vec<Session>>,
}

#[derive(Debug, Deserialize)]
struct Session {
    name: String,
}

/// A machine that did not answer stays in the answer, carrying why (Y-054).
#[derive(Debug, Deserialize)]
#[serde(tag = "reached", rename_all = "lowercase")]
enum Reached<T> {
    Yes {
        #[serde(alias = "sessions", alias = "status")]
        value: T,
    },
    No {
        error: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct Status {
    machine: String,
    #[serde(flatten)]
    reached: Reached<State>,
}

/// Only the tag: `crashed`'s exit status and `unclear`'s reason are not drawn.
#[derive(Debug, Deserialize)]
struct State {
    state: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct Attention {
    reviews: Vec<Item>,
    issues: Vec<Item>,
    notifications: u32,
}

#[derive(Debug, Deserialize)]
struct Item {
    repo: String,
    number: u64,
    title: String,
}

/// The 404 body: a workspace the agent look does not know.
#[derive(Deserialize)]
struct Missing {
    error: String,
}

/// One poll's answers. A status is read for each workspace that loaded.
#[derive(Debug)]
pub struct Reads {
    machines: Answer<Vec<Machine>>,
    workspaces: Answer<Vec<Listed>>,
    sessions: Answer<Vec<MachineSessions>>,
    attention: Answer<Attention>,
    statuses: BTreeMap<String, Answer<Status>>,
}

pub async fn fetch(daemon: String) -> Result<Reads, Error> {
    let base = daemon.trim_end_matches('/').to_owned();
    tokio::task::spawn_blocking(move || read(&base))
        .await
        .unwrap_or_else(|error| {
            Err(Error::Unreachable {
                daemon,
                detail: error.to_string(),
            })
        })
}

fn read(base: &str) -> Result<Reads, Error> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(TIMEOUT))
        .build()
        .into();
    let machines = answer(&agent, base, "/api/machines")?;
    let workspaces: Answer<Vec<Listed>> = answer(&agent, base, "/api/workspaces")?;
    let sessions = answer(&agent, base, "/api/sessions")?;
    let attention = answer(&agent, base, "/api/attention")?;
    let mut statuses = BTreeMap::new();
    if let Answer::Ok { data, .. } = &workspaces {
        for listed in data {
            if let Loaded::Yes { .. } = listed.loaded {
                let path = format!("/api/workspaces/{}/status", listed.name);
                statuses.insert(listed.name.clone(), answer(&agent, base, &path)?);
            }
        }
    }
    Ok(Reads {
        machines,
        workspaces,
        sessions,
        attention,
        statuses,
    })
}

/// A refusal, such as a status route's 404, is that class's failure and not the poll's.
fn answer<T: for<'de> Deserialize<'de>>(
    agent: &ureq::Agent,
    base: &str,
    path: &str,
) -> Result<Answer<T>, Error> {
    let mut response =
        agent
            .get(format!("{base}{path}"))
            .call()
            .map_err(|error| Error::Unreachable {
                daemon: base.to_owned(),
                detail: error.to_string(),
            })?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|error| unreadable(base, path, error))?;
    if !(200..300).contains(&status) {
        let said = serde_json::from_str::<Missing>(&body)
            .map(|missing| missing.error)
            .unwrap_or_else(|_| body.trim().to_owned());
        return Ok(Answer::Failed {
            error: format!("yantrad answered {status}: {said}"),
        });
    }
    serde_json::from_str(&body).map_err(|error| unreadable(base, path, error))
}

fn unreadable(base: &str, path: &str, error: impl ToString) -> Error {
    Error::Unreadable {
        daemon: base.to_owned(),
        path: path.to_owned(),
        detail: error.to_string(),
    }
}

/// `?` is a session whose state was not read; the four others are the web's
/// bands in `work.ts`, except that `no_agent` is idle here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    Blocked,
    Working,
    Done,
    Idle,
    Unread,
}

impl Mark {
    fn of(state: &str) -> Self {
        match state {
            "awaiting_trust" | "crashed" | "killed" | "unclear" => Self::Blocked,
            "running" => Self::Working,
            "finished" | "stopped" => Self::Done,
            "no_session" | "no_agent" => Self::Idle,
            _ => Self::Unread,
        }
    }

    fn word(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::Working => "working",
            Self::Done => "done",
            Self::Idle => "idle",
            Self::Unread => "?",
        }
    }

    fn colour(self) -> Color {
        match self {
            Self::Blocked => Color::Red,
            Self::Working => Color::Green,
            Self::Done => Color::Blue,
            Self::Idle | Self::Unread => Color::DarkGray,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub machine: String,
    pub session: String,
    pub workspace: Option<String>,
    pub mark: Mark,
    /// Whether tmux holds the session. A workspace with none is still a row.
    pub live: bool,
}

/// A section is its rows, or the sentence that says why there are none to trust.
pub type Section<T> = Result<Vec<T>, String>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Board {
    pub needs: Section<String>,
    pub sessions: Section<SessionRow>,
    pub machines: Section<String>,
    pub ages: Vec<String>,
}

impl Board {
    /// Every section says the same thing: the daemon itself did not answer.
    pub fn failed(reason: &str) -> Self {
        Self {
            needs: Err(reason.to_owned()),
            sessions: Err(reason.to_owned()),
            machines: Err(reason.to_owned()),
            ages: Vec::new(),
        }
    }
}

fn section<T, R>(answer: &Answer<T>, rows: impl FnOnce(&T) -> Vec<R>) -> Section<R> {
    match answer {
        Answer::Ok { data, .. } => Ok(rows(data)),
        Answer::Failed { error } => Err(format!("failed: {error}")),
        Answer::Never => Err("not read yet".to_owned()),
    }
}

fn age<T>(class: &str, answer: &Answer<T>) -> String {
    match answer {
        Answer::Ok { age_seconds, .. } => format!("{class} {age_seconds} s"),
        Answer::Failed { .. } => format!("{class} failed"),
        Answer::Never => format!("{class} not read"),
    }
}

pub fn board(reads: &Reads) -> Board {
    let loaded: Vec<(&str, &str)> = match &reads.workspaces {
        Answer::Ok { data, .. } => data
            .iter()
            .filter_map(|one| match &one.loaded {
                Loaded::Yes { machine } => Some((one.name.as_str(), machine.as_str())),
                Loaded::No { .. } => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let state = |workspace: &str| match reads.statuses.get(workspace) {
        Some(Answer::Ok {
            data:
                Status {
                    reached: Reached::Yes { value },
                    ..
                },
            ..
        }) => Some(value.state.as_str()),
        _ => None,
    };

    // One row per machine that did not answer, as `work.ts` does: its
    // workspaces are downstream of it and are not listed.
    let mut unreachable: BTreeMap<String, String> = BTreeMap::new();
    if let Answer::Ok { data, .. } = &reads.sessions {
        for answer in data {
            if let Reached::No { error } = &answer.reached {
                unreachable.insert(answer.machine.clone(), error.clone());
            }
        }
    }
    for status in reads.statuses.values() {
        if let Answer::Ok { data, .. } = status
            && let Reached::No { error } = &data.reached
        {
            unreachable
                .entry(data.machine.clone())
                .or_insert_with(|| error.clone());
        }
    }

    let sessions = section(&reads.sessions, |answers| {
        let mut rows = Vec::new();
        for answer in answers {
            let Reached::Yes { value } = &answer.reached else {
                continue;
            };
            for session in value {
                let workspace = loaded
                    .iter()
                    .find(|(name, machine)| *name == session.name && *machine == answer.machine)
                    .map(|(name, _)| (*name).to_owned());
                // A session no workspace claims has no status to read (R-23).
                rows.push(SessionRow {
                    mark: workspace
                        .as_deref()
                        .and_then(state)
                        .map_or(Mark::Unread, Mark::of),
                    machine: answer.machine.clone(),
                    session: session.name.clone(),
                    workspace,
                    live: true,
                });
            }
        }
        for (name, machine) in &loaded {
            let live = rows
                .iter()
                .any(|row: &SessionRow| row.machine == *machine && row.session == *name);
            if !live && !unreachable.contains_key(*machine) {
                rows.push(SessionRow {
                    machine: (*machine).to_owned(),
                    session: (*name).to_owned(),
                    workspace: Some((*name).to_owned()),
                    mark: Mark::Idle,
                    live: false,
                });
            }
        }
        rows
    });

    let mut needs = Vec::new();
    if let Ok(rows) = &sessions {
        for row in rows.iter().filter(|row| row.mark == Mark::Blocked) {
            let said = row.workspace.as_deref().and_then(state).unwrap_or_default();
            needs.push(format!(
                "agent {} on {}: {}",
                row.session,
                row.machine,
                said.replace('_', " ")
            ));
        }
    }
    for (machine, error) in &unreachable {
        needs.push(format!("{machine} did not answer: {error}"));
    }
    match &reads.workspaces {
        Answer::Ok { data, .. } => {
            for one in data {
                if let Loaded::No { error } = &one.loaded {
                    needs.push(format!("workspace {} does not load: {error}", one.name));
                }
            }
        }
        Answer::Failed { error } => needs.push(format!("workspaces failed: {error}")),
        Answer::Never => needs.push("workspaces not read yet".to_owned()),
    }
    match &reads.attention {
        Answer::Ok { data, .. } => {
            for (kind, items) in [("review", &data.reviews), ("issue", &data.issues)] {
                for item in items {
                    needs.push(format!(
                        "{kind} {}#{} {}",
                        item.repo, item.number, item.title
                    ));
                }
            }
            if data.notifications > 0 {
                needs.push(format!("{} unread on GitHub", data.notifications));
            }
        }
        Answer::Failed { error } => needs.push(format!("GitHub failed: {error}")),
        Answer::Never => needs.push("GitHub not read yet".to_owned()),
    }

    let machines = section(&reads.machines, |machines| {
        machines
            .iter()
            .map(|machine| {
                let mut line = format!(
                    "{}  {}",
                    machine.name,
                    if machine.online { "online" } else { "offline" }
                );
                if machine.expired {
                    line.push_str("  key expired");
                }
                match &machine.heartbeat {
                    Some(beat) => line.push_str(&format!("  beat {} s ago", beat.age_seconds)),
                    None => line.push_str("  never heard from"),
                }
                line
            })
            .collect()
    });

    Board {
        needs: Ok(needs),
        sessions,
        machines,
        ages: vec![
            age("machines", &reads.machines),
            age("workspaces", &reads.workspaces),
            age("sessions", &reads.sessions),
            age("github", &reads.attention),
        ],
    }
}

#[derive(Debug, Default)]
pub struct Selection {
    pub selected: usize,
    /// The last error or the last attach, shown until the next key.
    pub message: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Quit,
    Attach { machine: String, session: String },
}

pub fn on_key(state: &mut Selection, board: &Board, key: KeyEvent, view_only: bool) -> Action {
    let rows = board.sessions.as_deref().unwrap_or_default();
    let last = rows.len().saturating_sub(1);
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => return Action::Quit,
        KeyCode::Up | KeyCode::Char('k') => state.selected = state.selected.saturating_sub(1),
        KeyCode::Down | KeyCode::Char('j') => state.selected = (state.selected + 1).min(last),
        KeyCode::Enter if !view_only => {
            if let Some(row) = rows.get(state.selected) {
                return Action::Attach {
                    machine: row.machine.clone(),
                    session: row.session.clone(),
                };
            }
        }
        _ => {}
    }
    state.selected = state.selected.min(last);
    Action::None
}

pub fn render(board: &Board, state: &Selection, view_only: bool, frame: &mut Frame) {
    let needs_height = match &board.needs {
        Ok(rows) => rows.len().clamp(1, 8) as u16 + 2,
        Err(_) => 3,
    };
    let [needs, sessions, machines, footer] = Layout::vertical([
        Constraint::Length(needs_height),
        Constraint::Fill(2),
        Constraint::Fill(1),
        Constraint::Length(2),
    ])
    .areas(frame.area());

    let lines = |section: &Section<String>, empty: &str| -> Vec<Line<'static>> {
        match section {
            Ok(rows) if rows.is_empty() => vec![Line::from(empty.to_owned())],
            Ok(rows) => rows.iter().map(|row| Line::from(row.clone())).collect(),
            Err(reason) => vec![Line::styled(reason.clone(), Color::Red)],
        }
    };
    frame.render_widget(
        Paragraph::new(lines(&board.needs, "nothing needs you"))
            .block(Block::bordered().title(" Needs you ")),
        needs,
    );

    let block = Block::bordered().title(" Sessions ");
    match &board.sessions {
        Ok(rows) => {
            let table = Table::new(
                rows.iter().map(|row| {
                    Row::new([
                        Span::styled(row.mark.word(), Style::new().fg(row.mark.colour())),
                        Span::raw(row.session.clone()),
                        Span::raw(row.machine.clone()),
                        Span::raw(match (&row.workspace, row.live) {
                            (Some(workspace), true) => workspace.clone(),
                            (Some(_), false) => "(no session)".to_owned(),
                            (None, _) => "—".to_owned(),
                        }),
                    ])
                }),
                [
                    Constraint::Length(8),
                    Constraint::Fill(1),
                    Constraint::Fill(1),
                    Constraint::Fill(1),
                ],
            )
            .header(Row::new(["AGENT", "SESSION", "MACHINE", "WORKSPACE"]).bold())
            .row_highlight_style(Modifier::REVERSED)
            .highlight_symbol("> ")
            .block(block);
            let mut selected = TableState::default().with_selected(Some(state.selected));
            frame.render_stateful_widget(table, sessions, &mut selected);
        }
        Err(reason) => frame.render_widget(
            Paragraph::new(Line::styled(reason.clone(), Color::Red)).block(block),
            sessions,
        ),
    }

    frame.render_widget(
        Paragraph::new(lines(&board.machines, "yantrad knows no machines"))
            .block(Block::bordered().title(" Machines ")),
        machines,
    );

    let keys = if view_only {
        "view only · ↑↓ select · q quit"
    } else {
        "↑↓ select · enter attach · q quit"
    };
    let first = state
        .message
        .clone()
        .unwrap_or_else(|| board.ages.join(" · "));
    frame.render_widget(
        Paragraph::new(vec![Line::from(first), Line::from(keys).dim()]),
        footer,
    );
}

/// Exits 0 on `q`. The caller has checked that stdin and stdout are terminals.
pub async fn run(daemon: String, view_only: bool) -> ExitCode {
    let mut screen = match ratatui::try_init() {
        Ok(screen) => screen,
        Err(error) => {
            eprintln!("yantra: could not open the terminal: {error}");
            return ExitCode::FAILURE;
        }
    };
    // `try_init` restores on a panic; this restores on every other way out.
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            ratatui::restore();
        }
    }
    let _restore = Restore;
    match drive(&mut screen, daemon, view_only).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            drop(_restore);
            eprintln!("yantra: the terminal failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn drive(
    screen: &mut DefaultTerminal,
    daemon: String,
    view_only: bool,
) -> std::io::Result<()> {
    let mut state = Selection::default();
    loop {
        let shown = match fetch(daemon.clone()).await {
            Ok(reads) => board(&reads),
            Err(error) => Board::failed(&error.to_string()),
        };
        let until = Instant::now() + POLL;
        loop {
            screen.draw(|frame| render(&shown, &state, view_only, frame))?;
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() || !event::poll(left)? {
                break;
            }
            let Event::Key(key) = event::read()? else {
                continue;
            };
            if key.kind != KeyEventKind::Press {
                continue;
            }
            state.message = None;
            match on_key(&mut state, &shown, key, view_only) {
                Action::None => {}
                Action::Quit => return Ok(()),
                Action::Attach { machine, session } => {
                    ratatui::try_restore()?;
                    state.message = hand_over(&machine, &session).await;
                    terminal::enable_raw_mode()?;
                    execute!(std::io::stdout(), terminal::EnterAlternateScreen)?;
                    screen.clear()?;
                    break;
                }
            }
        }
    }
}

/// Spawns rather than `exec`s, unlike `yantra attach`: the dashboard comes back
/// after the detach. The child shares the tty, so `SIGWINCH` reaches it.
async fn hand_over(machine: &str, session: &str) -> Option<String> {
    let plan = match attach::plan_on(machine, session, &super::local_term()).await {
        Ok(plan) => plan,
        Err(error) => return Some(format!("could not attach to {session}: {error}")),
    };
    if let Chosen::Substituted { wanted } = &plan.term {
        println!("{}", super::downgrade_notice(machine, wanted));
    }
    // I-63: `--` keeps a name beginning with `-` from being read as an option.
    let ran = tokio::process::Command::new("ssh")
        .arg("-t")
        .arg("--")
        .arg(machine)
        .arg(attach::remote_command(
            &plan.tmux.command(),
            &plan.session,
            plan.term.term(),
        ))
        .status()
        .await;
    match ran {
        Ok(status) if status.success() => None,
        Ok(status) => Some(format!("ssh to {machine} ended: {status}")),
        Err(error) => Some(format!("could not run ssh: {error}")),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::{Cli, Command};
    use axum::Router;
    use axum::http::StatusCode;
    use axum::routing::get;
    use clap::Parser as _;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::KeyModifiers;

    #[test]
    fn dash_needs_the_daemon_and_takes_view_only() {
        let parsed = Cli::try_parse_from(["yantra", "dash", "--daemon", "u"]).expect("parses");
        assert!(matches!(
            parsed.command,
            Some(Command::Dash { daemon, view_only: false }) if daemon == "u"
        ));
        let parsed = Cli::try_parse_from(["yantra", "dash", "--daemon", "u", "--view-only"])
            .expect("parses");
        assert!(matches!(
            parsed.command,
            Some(Command::Dash {
                view_only: true,
                ..
            })
        ));
        assert!(Cli::try_parse_from(["yantra", "dash"]).is_err());
    }

    fn json<T: for<'de> Deserialize<'de>>(text: &str) -> T {
        serde_json::from_str(text).expect("a fixture the daemon could send")
    }

    fn status(machine: &str, state: &str) -> Answer<Status> {
        json(&format!(
            r#"{{"looked":"ok","age_seconds":1,"data":{{"workspace":"w","machine":"{machine}",
                "reached":"yes","status":{{"state":"{state}","exit_status":1}},"session":null}}}}"#
        ))
    }

    /// One workspace `w` on `m`, with its session live, in `state`.
    fn one(state: &str) -> Reads {
        Reads {
            machines: json(
                r#"{"looked":"ok","age_seconds":3,"data":[{"name":"m","online":true,
                    "expired":false,"heartbeat":{"age_seconds":4}}]}"#,
            ),
            workspaces: json(
                r#"{"looked":"ok","age_seconds":2,"data":[{"name":"w","loaded":"yes",
                    "machine":"m","repo":"/r","startup":null}]}"#,
            ),
            sessions: json(
                r#"{"looked":"ok","age_seconds":2,"data":[{"machine":"m","reached":"yes",
                    "sessions":[{"name":"w","windows":1,"attached":0}]}]}"#,
            ),
            attention: json(
                r#"{"looked":"ok","age_seconds":9,"data":{"reviews":[],"issues":[],"notifications":0}}"#,
            ),
            statuses: BTreeMap::from([("w".to_owned(), status("m", state))]),
        }
    }

    fn rows(board: &Board) -> &[SessionRow] {
        board.sessions.as_deref().expect("sessions read")
    }

    #[test]
    fn each_of_the_nine_states_has_its_mark() {
        for (state, mark) in [
            ("awaiting_trust", Mark::Blocked),
            ("crashed", Mark::Blocked),
            ("killed", Mark::Blocked),
            ("unclear", Mark::Blocked),
            ("running", Mark::Working),
            ("finished", Mark::Done),
            ("stopped", Mark::Done),
            ("no_session", Mark::Idle),
            ("no_agent", Mark::Idle),
        ] {
            let board = board(&one(state));
            assert_eq!(rows(&board)[0].mark, mark, "{state}");
            let blocked = board
                .needs
                .as_deref()
                .expect("needs")
                .iter()
                .any(|line| line.starts_with("agent w on m"));
            assert_eq!(blocked, mark == Mark::Blocked, "{state}");
        }
        assert_eq!(
            board(&one("awaiting_trust")).needs,
            Ok(vec!["agent w on m: awaiting trust".to_owned()])
        );
    }

    #[test]
    fn an_unreachable_machine_is_one_row_and_its_workspaces_are_not_listed() {
        let mut reads = one("running");
        reads.workspaces = json(
            r#"{"looked":"ok","age_seconds":2,"data":[
                {"name":"a","loaded":"yes","machine":"pi","repo":"/r","startup":null},
                {"name":"b","loaded":"yes","machine":"pi","repo":"/r","startup":null}]}"#,
        );
        reads.sessions = json(
            r#"{"looked":"ok","age_seconds":2,"data":[{"machine":"pi","reached":"no","error":"timed out"}]}"#,
        );
        let dead: Answer<Status> = json(
            r#"{"looked":"ok","age_seconds":1,"data":{"workspace":"a","machine":"pi","reached":"no","error":"timed out"}}"#,
        );
        let also: Answer<Status> = json(
            r#"{"looked":"ok","age_seconds":1,"data":{"workspace":"b","machine":"pi","reached":"no","error":"timed out"}}"#,
        );
        reads.statuses = BTreeMap::from([("a".to_owned(), dead), ("b".to_owned(), also)]);
        let board = board(&reads);
        assert_eq!(
            board.needs,
            Ok(vec!["pi did not answer: timed out".to_owned()])
        );
        assert!(rows(&board).is_empty());
    }

    #[test]
    fn a_failed_or_unread_class_is_never_drawn_as_empty() {
        let mut reads = one("running");
        reads.sessions = json(r#"{"looked":"failed","age_seconds":1,"error":"no tmux"}"#);
        reads.machines = json(r#"{"looked":"never"}"#);
        reads.attention = json(r#"{"looked":"failed","age_seconds":1,"error":"no grant"}"#);
        reads.workspaces = json(r#"{"looked":"never"}"#);
        let board = board(&reads);
        assert_eq!(board.sessions, Err("failed: no tmux".to_owned()));
        assert_eq!(board.machines, Err("not read yet".to_owned()));
        assert_eq!(
            board.needs,
            Ok(vec![
                "workspaces not read yet".to_owned(),
                "GitHub failed: no grant".to_owned()
            ])
        );
        assert_eq!(
            board.ages,
            [
                "machines not read",
                "workspaces not read",
                "sessions failed",
                "github failed"
            ]
        );
    }

    #[test]
    fn unclaimed_sessions_unread_states_and_sessionless_workspaces() {
        let mut reads = one("running");
        reads.sessions = json(
            r#"{"looked":"ok","age_seconds":2,"data":[{"machine":"m","reached":"yes",
                "sessions":[{"name":"scratch","windows":1,"attached":1}]}]}"#,
        );
        reads.statuses = BTreeMap::from([("w".to_owned(), json(r#"{"looked":"never"}"#))]);
        let board = board(&reads);
        assert_eq!(
            rows(&board),
            [
                SessionRow {
                    machine: "m".to_owned(),
                    session: "scratch".to_owned(),
                    workspace: None,
                    mark: Mark::Unread,
                    live: true,
                },
                SessionRow {
                    machine: "m".to_owned(),
                    session: "w".to_owned(),
                    workspace: Some("w".to_owned()),
                    mark: Mark::Idle,
                    live: false,
                },
            ]
        );
        let mut reads = one("running");
        reads.statuses = BTreeMap::from([("w".to_owned(), json(r#"{"looked":"never"}"#))]);
        assert_eq!(rows(&super::board(&reads))[0].mark, Mark::Unread);
    }

    #[test]
    fn failed_workspaces_leave_every_live_session_unread() {
        let mut reads = one("awaiting_trust");
        reads.workspaces = json(r#"{"looked":"failed","age_seconds":1,"error":"bad toml"}"#);
        let board = board(&reads);
        assert_eq!(rows(&board).len(), 1);
        assert_eq!(rows(&board)[0].mark, Mark::Unread);
        assert_eq!(
            board.needs,
            Ok(vec!["workspaces failed: bad toml".to_owned()])
        );
    }

    #[test]
    fn github_and_files_that_do_not_load_need_you() {
        let mut reads = one("running");
        reads.attention = json(
            r#"{"looked":"ok","age_seconds":9,"data":{"notifications":3,
                "reviews":[{"repo":"o/y","number":7,"title":"Fix","url":"u","updated_at":"t"}],
                "issues":[{"repo":"o/y","number":8,"title":"Bug","url":"u","updated_at":"t"}]}}"#,
        );
        reads.workspaces = json(
            r#"{"looked":"ok","age_seconds":2,"data":[
                {"name":"w","loaded":"yes","machine":"m","repo":"/r","startup":null},
                {"name":"bad","loaded":"no","error":"missing field `machine`"}]}"#,
        );
        assert_eq!(
            board(&reads).needs,
            Ok(vec![
                "workspace bad does not load: missing field `machine`".to_owned(),
                "review o/y#7 Fix".to_owned(),
                "issue o/y#8 Bug".to_owned(),
                "3 unread on GitHub".to_owned(),
            ])
        );
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn two() -> Board {
        let mut reads = one("running");
        reads.sessions = json(
            r#"{"looked":"ok","age_seconds":2,"data":[{"machine":"m","reached":"yes",
                "sessions":[{"name":"w"},{"name":"x"}]}]}"#,
        );
        board(&reads)
    }

    #[test]
    fn enter_attaches_to_the_selected_row_unless_view_only() {
        let board = two();
        let mut state = Selection::default();
        assert_eq!(
            on_key(&mut state, &board, key(KeyCode::Down), false),
            Action::None
        );
        assert_eq!(
            on_key(&mut state, &board, key(KeyCode::Enter), false),
            Action::Attach {
                machine: "m".to_owned(),
                session: "x".to_owned()
            }
        );
        assert_eq!(
            on_key(&mut state, &board, key(KeyCode::Enter), true),
            Action::None
        );
        assert_eq!(
            on_key(&mut state, &board, key(KeyCode::Char('q')), true),
            Action::Quit
        );
        assert_eq!(
            on_key(&mut state, &board, key(KeyCode::Esc), false),
            Action::Quit
        );
    }

    #[test]
    fn the_selection_stays_inside_the_list() {
        let board = two();
        let mut state = Selection::default();
        on_key(&mut state, &board, key(KeyCode::Up), false);
        assert_eq!(state.selected, 0);
        for _ in 0..5 {
            on_key(&mut state, &board, key(KeyCode::Char('j')), false);
        }
        assert_eq!(state.selected, 1);
        on_key(&mut state, &board, key(KeyCode::Char('k')), false);
        assert_eq!(state.selected, 0);
        let mut state = Selection {
            selected: 9,
            message: None,
        };
        let empty = Board::failed("down");
        assert_eq!(
            on_key(&mut state, &empty, key(KeyCode::Enter), false),
            Action::None
        );
        assert_eq!(state.selected, 0);
    }

    fn screen(board: &Board, view_only: bool) -> String {
        let mut terminal = Terminal::new(TestBackend::new(90, 30)).expect("a test terminal");
        terminal
            .draw(|frame| render(board, &Selection::default(), view_only, frame))
            .expect("drawn");
        let buffer = terminal.backend().buffer();
        buffer
            .content()
            .chunks(buffer.area.width as usize)
            .map(|line| line.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn every_mark_is_drawn_and_the_footer_says_view_only() {
        for (state, word) in [
            ("crashed", "blocked"),
            ("running", "working"),
            ("finished", "done"),
            ("no_agent", "idle"),
        ] {
            let text = screen(&board(&one(state)), false);
            assert!(text.contains(word), "{state}\n{text}");
            assert!(text.contains("enter attach"), "{text}");
        }
        let text = screen(&board(&one("running")), true);
        assert!(text.contains("view only"), "{text}");
        assert!(!text.contains("enter attach"), "{text}");
        assert!(text.contains("machines 3 s"), "{text}");
        assert!(text.contains("m  online  beat 4 s ago"), "{text}");
    }

    #[test]
    fn a_failed_class_shows_its_reason() {
        let mut reads = one("running");
        reads.sessions = json(r#"{"looked":"failed","age_seconds":1,"error":"no tmux"}"#);
        let text = screen(&board(&reads), false);
        assert!(text.contains("failed: no tmux"), "{text}");
        let text = screen(&Board::failed("could not reach yantrad"), false);
        assert_eq!(text.matches("could not reach yantrad").count(), 3, "{text}");
    }

    /// Serves the five routes. `status` is the workspace route's answer.
    async fn daemon(status: (StatusCode, &'static str), sessions: &'static str) -> String {
        let app = Router::new()
            .route(
                "/api/machines",
                get(|| async { r#"{"looked":"ok","age_seconds":3,"data":[]}"# }),
            )
            .route(
                "/api/workspaces",
                get(|| async {
                    r#"{"looked":"ok","age_seconds":2,"data":[{"name":"w","loaded":"yes",
                        "machine":"m","repo":"/r","startup":null}]}"#
                }),
            )
            .route("/api/sessions", get(move || async move { sessions }))
            .route("/api/attention", get(|| async { r#"{"looked":"never"}"# }))
            .route(
                "/api/workspaces/{name}/status",
                get(move || async move { status }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port");
        let address = listener.local_addr().expect("an address");
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{address}/")
    }

    const SESSIONS: &str = r#"{"looked":"ok","age_seconds":2,"data":[{"machine":"m",
        "reached":"yes","sessions":[{"name":"w","windows":1,"attached":0,"created":"x","created_at":1}]}]}"#;
    const RUNNING: &str = r#"{"looked":"ok","age_seconds":1,"data":{"workspace":"w",
        "machine":"m","reached":"yes","status":{"state":"running"},"session":null}}"#;

    #[tokio::test]
    async fn fetch_reads_every_class_and_keeps_its_three_answers() {
        let reads = fetch(daemon((StatusCode::OK, RUNNING), SESSIONS).await)
            .await
            .expect("an answer");
        let shown = board(&reads);
        assert_eq!(rows(&shown)[0].mark, Mark::Working);
        assert_eq!(shown.machines, Ok(Vec::new()));
        assert_eq!(shown.needs, Ok(vec!["GitHub not read yet".to_owned()]));

        let failed = r#"{"looked":"failed","age_seconds":1,"error":"no tmux"}"#;
        let reads = fetch(daemon((StatusCode::OK, RUNNING), failed).await)
            .await
            .expect("an answer");
        assert_eq!(board(&reads).sessions, Err("failed: no tmux".to_owned()));
    }

    #[tokio::test]
    async fn a_status_404_is_that_workspaces_failure() {
        let reads = fetch(
            daemon(
                (
                    StatusCode::NOT_FOUND,
                    r#"{"error":"no workspace named `w`"}"#,
                ),
                SESSIONS,
            )
            .await,
        )
        .await
        .expect("an answer");
        assert!(
            matches!(
                reads.statuses.get("w"),
                Some(Answer::Failed { error }) if error == "yantrad answered 404: no workspace named `w`"
            ),
            "{reads:?}"
        );
        assert_eq!(rows(&board(&reads))[0].mark, Mark::Unread);
        let reads = fetch(daemon((StatusCode::OK, r#"{"looked":"never"}"#), SESSIONS).await)
            .await
            .expect("an answer");
        assert!(matches!(reads.statuses.get("w"), Some(Answer::Never)));
    }

    #[tokio::test]
    async fn an_unreadable_body_names_the_route() {
        let err = fetch(daemon((StatusCode::OK, RUNNING), "<html>hi</html>").await)
            .await
            .expect_err("not JSON");
        assert!(
            matches!(&err, Error::Unreadable { path, .. } if path == "/api/sessions"),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn a_daemon_that_cannot_be_reached_is_named() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("an address");
        drop(listener);
        let err = fetch(format!("http://{address}"))
            .await
            .expect_err("nothing listens");
        assert!(
            err.to_string()
                .starts_with(&format!("could not reach yantrad at http://{address}: ")),
            "{err}"
        );
    }
}
