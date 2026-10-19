# The smoke pass

Four releases shipped while the 61-box pass ([v0.7.2-qa-pass.md](v0.7.2-qa-pass.md), 60 boxes) went unwalked. A pass that long does not get walked at each release. The owner confirmed on 2026-10-19 (Y-482) that a 15-check smoke pass is the release gate.

## The rule

Each release walks these 15 checks on the installed release before its row closes. A release is each "Cut vX" or "vX.Y.Z" row. A failed check becomes a row in `tracker.md`. The owner walks the pass, and it takes about 15 minutes.

## The checks

Each check is something a container cannot prove. The Twin test column names the test that covers the same behaviour in CI. A twin proves the code path. The check proves the real box, the real phone and the real login.

| N | Do | Expect | Twin test |
| --- | --- | --- | --- |
| 1 | Install on the real box with `install.sh`. | The install ends on a working dashboard URL. | `crates/yantrad/tests/installer.rs`, `at_a_terminal_a_yes_starts_the_dashboard_and_a_second_run_asks_nothing` |
| 2 | Update the box: Settings → About → Update, or `sudo yantra update`. | The update finishes and the dashboard comes back. | `crates/yantrad/tests/update.rs`, `an_update_restarts_the_daemon_and_the_session_and_its_socket_survive` |
| 3 | Run `yantra --version` on the box. | It prints the version of the tag. | `crates/yantrad/tests/installer.rs`, `the_fixtures_archive_is_shaped_the_way_release_yml_stages_one` |
| 4 | Keep a live session open, then update (check 2). | The session is still running after the update. | `crates/yantrad/tests/update.rs`, `an_update_restarts_the_daemon_and_the_session_and_its_socket_survive` |
| 5 | Open the dashboard on the phone. | The board loads, reads well and scrolls. | `web/e2e/smoke.spec.ts`, `looks like the board` |
| 6 | Turn one machine off or let it sleep. | The dashboard shows it as asleep or off. | `web/e2e/setup.spec.ts`, `draws asleep machines as asleep, with nothing to press` |
| 7 | Start a new session on a real machine. | The session opens in the chosen folder and attaches. | `crates/yantra-core/tests/up_walking_skeleton.rs`, `the_session_opens_in_the_workspace_repo` |
| 8 | In Chat, send a prompt that needs a permission. | The reply streams and a permission card appears. | `web/e2e/chat.spec.ts`, `Full access draws no permission card` |
| 9 | Press Stop during a turn. | The turn ends and the session stays. | `crates/yantra-core/tests/down.rs`, `the_session_and_the_process_in_it_are_both_gone` |
| 10 | Start a turn, open Terminal, then go back to Chat. | The turn kept running. | `web/e2e/chat.spec.ts`, `Terminal and back keeps a turn running` |
| 11 | Trigger a ntfy push. | The push arrives on the phone. | `web/e2e/notifications.spec.ts`, `shows every command via Copyable, the full warning, and Open` |
| 12 | Connect GitHub with the device code. | The code is accepted and GitHub shows as connected. | `crates/yantra-core/tests/github_api.rs`, `the_real_api_answers_in_the_shapes_this_crate_reads` |
| 13 | Speak into the mic in the dashboard. | The words reach the session. | `crates/yantrad/tests/mic.rs`, `the_dashboards_writer_carries_a_tone_into_yantra_mic_and_ends_when_closed` |
| 14 | Open Setup on a real machine. | Every check reads true to the machine. | `crates/yantra-core/tests/doctor.rs`, `a_machine_with_everything_reports_present_except_the_beat` |
| 15 | Open Settings → About. | The version equals the tag and the facts are right. | `web/e2e/settings.spec.ts`, `asks for an update after saying what the restart ends` |

Some twins cover only part of a check. For example, no test draws a permission card or presses Stop in the browser. Swap any check or twin that the owner finds wrong.

## The full pass is quarterly

The owner walks [m15-qa-pass.md](m15-qa-pass.md) and the newest full release pass, [v0.7.2-qa-pass.md](v0.7.2-qa-pass.md), once a quarter. They are not walked at each release.
