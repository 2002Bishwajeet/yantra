import { Link } from "@tanstack/react-router";
import type {
  Listed,
  Machine,
  MachineSessions,
  Readiness as Report,
  Workspace,
} from "@/api";
import { machineColumns, sessionColumns } from "@/columns";
import { DataTable } from "@/components/DataTable";
import { Readiness } from "@/components/Readiness";
import { Section } from "@/components/Section";
import { Title } from "@/components/Title";
import { Unreachable, unreachable } from "@/components/Unreachable";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { loaded, sessionsWaiting, useLooked } from "@/useLooked";
import { unclaimed } from "@/work";
import type { Reading } from "@/useLooked";

/** The three groups D3 §3.1 takes off the work page. This page answers *which
 *  machine*; [`/m/{name}`](./OneMachine.tsx) answers *what about this one*. */
export function Machines() {
  const machines = useLooked<Machine[]>("/api/machines");
  const listed = useLooked<Listed[]>("/api/workspaces");
  const sessions = useLooked<MachineSessions[]>("/api/sessions");
  const readiness = useLooked<Report[]>("/api/readiness");
  const nothing = unreachable([machines, listed, sessions, readiness]);

  return (
    <>
      <Title>Machines</Title>
      {nothing && <Unreachable error={nothing} />}

      {!nothing && (
        <>
          <Section title="Machines" query={machines}>
            {(rows) => (
              <DataTable
                columns={machineColumns}
                rows={rows}
                rowKey={(machine) => machine.name}
                empty="no machines on this tailnet"
              />
            )}
          </Section>

          <Section title="Readiness" query={readiness}>
            {(reports) => <Ready reports={reports} machines={machines} />}
          </Section>

          <Section
            title="Unclaimed sessions"
            query={sessions}
            waiting={sessionsWaiting(sessions)}
          >
            {(answers) => (
              <Unclaimed answers={answers} workspaces={loaded(listed)} />
            )}
          </Section>
        </>
      )}
    </>
  );
}

/** One card per machine the sweep covered, which is the machines a workspace
 *  names rather than the whole tailnet — a machine none of them names has not
 *  been asked, and saying so is D2's own distinction between *not ready* and
 *  *not looked at*. */
export function Ready({
  reports,
  machines,
}: {
  reports: Report[];
  machines: Reading<Machine[]>;
}) {
  const listed = machines.looked === "ok" ? machines.data : [];

  return (
    <div className="flex flex-col gap-4">
      {reports.length === 0 && (
        <p className="text-muted-foreground text-sm">
          no workspace names a machine, so nothing has been asked
        </p>
      )}
      {reports.map((report) => (
        <div className="flex flex-col gap-2" key={report.machine}>
          <Link
            className="text-sm font-medium"
            params={{ machine: report.machine }}
            to="/m/$machine"
          >
            {report.machine}
          </Link>
          <Readiness
            machine={listed.find((one) => one.name === report.machine)}
            report={report}
          />
        </div>
      ))}
    </div>
  );
}

/** D3 §14: a session a workspace claims **is** that workspace's row on the work
 *  page, so listing it again here would be the duplication §2 finding 2 names.
 *  What is left is holding a machine and nothing else in Yantra mentions it. */
export function Unclaimed({
  answers,
  workspaces,
}: {
  answers: MachineSessions[];
  workspaces: Reading<Workspace[]>;
}) {
  const rows = unclaimed(answers, workspaces);
  const unreachable = answers.filter((answer) => answer.reached === "no");

  return (
    <div className="flex flex-col gap-2">
      <DataTable
        columns={sessionColumns(workspaces)}
        rows={rows}
        rowKey={(row) => `${row.machine} ${row.session.name}`}
        empty={
          // A look that failed never reaches here, so the workspaces reading is
          // the only thing that can leave *claimed* unknown.
          workspaces.looked === "ok"
            ? "every tmux session on the machines that answered belongs to a workspace"
            : "no workspace list to check these against, so none can be called unclaimed"
        }
      />
      {/* The machines that did not answer are named, and the count says how many
          did — without which an unreachable machine reads as a machine with no
          sessions. */}
      <p className="text-muted-foreground text-sm">
        {rows.length} unclaimed on {answers.length - unreachable.length} of{" "}
        {answers.length} machines
      </p>
      {unreachable.map((answer) => (
        <Alert key={answer.machine} variant="destructive">
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {`${answer.machine} unreachable: ${answer.error}`}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
