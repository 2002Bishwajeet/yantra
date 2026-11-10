//! `yantra jobs`: this machine's systemd user timers (Y-706).

use std::process::ExitCode;

use yantra_core::jobs::{self, Job, LastResult, StateFile};

/// Exit 1 when any job's last run failed: `doctor`'s rule, so a timer's
/// failure shows to whoever runs this from a script.
pub async fn run(json: bool) -> ExitCode {
    let jobs = match jobs::list().await {
        Ok(jobs) => jobs,
        Err(err) => {
            crate::report_error(&err);
            return ExitCode::FAILURE;
        }
    };
    if json {
        match serde_json::to_string_pretty(&jobs) {
            Ok(rendered) => println!("{rendered}"),
            Err(err) => {
                crate::report_error(&err);
                return ExitCode::FAILURE;
            }
        }
    } else {
        print!("{}", render(&jobs));
    }
    if any_failed(&jobs) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn any_failed(jobs: &[Job]) -> bool {
    jobs.iter()
        .any(|job| matches!(job.last_result, LastResult::Failed { .. }))
}

fn render(jobs: &[Job]) -> String {
    if jobs.is_empty() {
        return "no systemd user timers on this machine\n".to_owned();
    }
    let rows: Vec<Vec<String>> = jobs
        .iter()
        .map(|job| {
            vec![
                job.timer.clone(),
                job.service.clone(),
                minute(job.next_local.as_deref()),
                minute(job.last_local.as_deref()),
                result(&job.last_result),
            ]
        })
        .collect();
    let table = crate::table(&["TIMER", "SERVICE", "NEXT", "LAST", "RESULT"], &rows);

    let mut lines = table.lines();
    let mut out = String::new();
    if let Some(heading) = lines.next() {
        out.push_str(heading);
        out.push('\n');
    }
    for (line, job) in lines.zip(jobs) {
        out.push_str(line);
        out.push('\n');
        match &job.state {
            None => {}
            Some(StateFile::Unreadable(reason)) => {
                out.push_str(&format!("  state file unreadable: {reason}\n"));
            }
            Some(StateFile::Read(fields)) => {
                for (key, value) in &fields.0 {
                    let value = value
                        .as_str()
                        .map_or_else(|| value.to_string(), str::to_owned);
                    out.push_str(&format!("  {key}: {value}\n"));
                }
            }
        }
    }
    out
}

/// `Tue 2026-12-01 06:03:56 IST` becomes `2026-12-01 06:03`.
fn minute(local: Option<&str>) -> String {
    let mut words = local.unwrap_or_default().split_whitespace().skip(1);
    match (words.next(), words.next()) {
        (Some(date), Some(time)) => format!("{date} {}", time.get(..5).unwrap_or(time)),
        _ => "-".to_owned(),
    }
}

fn result(last: &LastResult) -> String {
    match last {
        LastResult::Never => "never".to_owned(),
        LastResult::Running => "running".to_owned(),
        LastResult::Succeeded => "succeeded".to_owned(),
        LastResult::Failed {
            status: Some(status),
            ..
        } => format!("failed (exit {status})"),
        LastResult::Failed { result, .. } => format!("failed ({result})"),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use yantra_core::jobs::Fields;

    fn job(timer: &str, last_result: LastResult) -> Job {
        Job {
            timer: format!("{timer}.timer"),
            service: format!("{timer}.service"),
            next: Some(1_796_085_236_425_850),
            last: None,
            next_local: Some("Tue 2026-12-01 06:03:56 IST".to_owned()),
            last_local: None,
            last_result,
            state: None,
        }
    }

    fn failed(result: &str, status: Option<i32>) -> LastResult {
        LastResult::Failed {
            result: result.to_owned(),
            status,
        }
    }

    #[test]
    fn every_last_result_has_its_word() {
        let mut ran = job("ran", LastResult::Succeeded);
        ran.last_local = Some("Mon 2026-11-09 06:03:01 IST".to_owned());
        let jobs = [
            job("invoice", LastResult::Never),
            job("busy", LastResult::Running),
            ran,
            job("false", failed("exit-code", Some(1))),
            job("slow", failed("timeout", None)),
        ];
        assert_eq!(
            render(&jobs),
            "\
TIMER          SERVICE          NEXT              LAST              RESULT
invoice.timer  invoice.service  2026-12-01 06:03  -                 never
busy.timer     busy.service     2026-12-01 06:03  -                 running
ran.timer      ran.service      2026-12-01 06:03  2026-11-09 06:03  succeeded
false.timer    false.service    2026-12-01 06:03  -                 failed (exit 1)
slow.timer     slow.service     2026-12-01 06:03  -                 failed (timeout)
"
        );
    }

    #[test]
    fn state_fields_print_under_their_job_in_file_order() {
        let mut invoice = job("invoice", LastResult::Succeeded);
        invoice.next_local = None;
        invoice.state = Some(StateFile::Read(Fields(vec![
            ("sent".to_owned(), "2026-11-01".into()),
            ("count".to_owned(), 3.into()),
            ("to".to_owned(), serde_json::json!(["a", "b"])),
        ])));
        let mut broken = job("broken", LastResult::Never);
        broken.state = Some(StateFile::Unreadable("EOF while parsing".to_owned()));
        assert_eq!(
            render(&[invoice, broken]),
            "\
TIMER          SERVICE          NEXT              LAST  RESULT
invoice.timer  invoice.service  -                 -     succeeded
  sent: 2026-11-01
  count: 3
  to: [\"a\",\"b\"]
broken.timer   broken.service   2026-12-01 06:03  -     never
  state file unreadable: EOF while parsing
"
        );
    }

    #[test]
    fn no_timers_is_one_line() {
        assert_eq!(render(&[]), "no systemd user timers on this machine\n");
    }

    #[test]
    fn only_a_failed_job_fails_the_exit() {
        assert!(!any_failed(&[]));
        assert!(!any_failed(&[
            job("a", LastResult::Never),
            job("b", LastResult::Running),
            job("c", LastResult::Succeeded),
        ]));
        assert!(any_failed(&[
            job("a", LastResult::Succeeded),
            job("b", failed("signal", None)),
        ]));
    }

    #[test]
    fn json_keeps_microseconds_a_tagged_result_and_the_state_object() {
        let mut invoice = job("invoice", failed("exit-code", Some(2)));
        invoice.state = Some(StateFile::Read(Fields(vec![(
            "sent".to_owned(),
            "2026-11-01".into(),
        )])));
        let value = serde_json::to_value([invoice]).expect("a job serialises");
        assert_eq!(value[0]["next"], 1_796_085_236_425_850_u64);
        assert_eq!(
            value[0]["last_result"],
            serde_json::json!({"kind": "failed", "result": "exit-code", "status": 2})
        );
        assert_eq!(value[0]["state"], serde_json::json!({"sent": "2026-11-01"}));
    }
}
