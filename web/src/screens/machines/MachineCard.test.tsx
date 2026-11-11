import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Check, Machine } from "@/api";
import { aMachine } from "@/api/fixtures";
import { MachineCard } from "./MachineCard";

afterEach(cleanup);

const present = (name: string): Check => ({
  check: name,
  state: "present",
  detail: "ok",
});

function renderCard(machine: Machine, checks: Check[]) {
  const root = createRootRoute({
    component: () => (
      <MachineCard
        checks={checks}
        machine={machine}
        pending={false}
        sessions={0}
      />
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("a ready machine whose microphone is not installed", () => {
  it("shows ready and no failing count", async () => {
    const checks = [
      "reachable",
      "sshd",
      "tmux",
      "git",
      "agent-cli",
      "terminfo",
      "provider-cli",
      "provider-auth",
      "login-session",
      "folder-access",
      "hooks",
      "no-sudo",
      "heartbeat",
    ].map(present);
    checks.push({
      check: "mic",
      state: "absent",
      detail: "not installed — the microphone is optional",
    });
    renderCard(aMachine(), checks);
    await screen.findByText("ready");
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("13 of 14")).toBeTruthy();
    expect(screen.queryByText(/failing/)).toBeNull();
  });
});

describe("a machine whose Tailscale lost its control server (Y-626)", () => {
  it("is not asleep and names the lost control link", async () => {
    renderCard(
      aMachine({
        name: "bishwajeets-macbook-pro",
        os: "macOS",
        online: true,
        control_lost: true,
        last_seen: "2026-11-04T09:00:00Z",
      }),
      ["reachable", "sshd", "tmux"].map(present),
    );
    await screen.findByText(
      "Tailscale lost its control server. The machine still answers over the tailnet.",
    );
    expect(screen.queryByText(/asleep/)).toBeNull();
  });

  it("says nothing about the control link while Tailscale can see the node", async () => {
    renderCard(aMachine(), ["reachable"].map(present));
    await screen.findByText("cachyos-g14");
    expect(screen.queryByText(/control server/)).toBeNull();
  });
});

describe("the joined account and sudo (Y-628)", () => {
  const withSudo = (state: Check["state"], detail: string) => [
    ...["reachable", "sshd", "tmux", "git", "agent-cli", "terminfo"].map(present),
    { check: "no-sudo", state, detail },
  ];

  it("warns, in words and not on hover, when agents can use sudo", async () => {
    renderCard(aMachine(), withSudo("absent", "the account is in the wheel group"));
    const note = await screen.findByRole("note");
    expect(note.textContent).toBe("Agents here can use sudo");
    expect(note.getAttribute("role")).toBe("note");
    expect(note.textContent).not.toContain("wheel");
  });

  it("says nothing when the account cannot use sudo", async () => {
    renderCard(aMachine(), withSudo("present", "there is no sudo here"));
    await screen.findByText(/ of \d+/);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says nothing when sudo could not be asked, because unknown is not absent", async () => {
    renderCard(aMachine(), withSudo("unknown", "could not be asked"));
    await screen.findByText(/ of \d+/);
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("a machine ssh cannot reach (Y-714)", () => {
  const checks: Check[] = [
    { check: "reachable", state: "absent", detail: "ssh: connect to host cachyos-g14 port 22: No route to host" },
    { check: "tmux", state: "unknown", detail: "could not be asked" },
    { check: "agent-cli", state: "unknown", detail: "could not be asked" },
    { check: "terminfo", state: "unknown", detail: "could not be asked" },
  ];

  it("says one sentence of cause, with no per-check list and no tally", async () => {
    renderCard(aMachine(), checks);
    await screen.findByText(/can’t reach cachyos-g14 over ssh/);
    expect(screen.getAllByText(/can’t reach cachyos-g14 over ssh/)).toHaveLength(1);
    expect(screen.queryByText("tmux")).toBeNull();
    expect(screen.queryByText(/could not be asked/)).toBeNull();
    expect(screen.queryByText(/of 4/)).toBeNull();
  });

  it("keeps ssh’s own words behind What ssh said, in the body font", async () => {
    renderCard(aMachine(), checks);
    const press = await screen.findByRole("button", { name: /What ssh said/ });
    expect(screen.queryByText(/No route to host/)).toBeNull();
    fireEvent.click(press);
    const said = screen.getByText(/No route to host/);
    expect(said.classList.contains("m3-mono")).toBe(false);
  });

  it("gives an offline machine the same one sentence, not a wall of unknown checks", async () => {
    renderCard(aMachine({ online: false }), checks);
    await screen.findByText(/can’t reach cachyos-g14 over ssh/);
    expect(screen.queryByText("tmux")).toBeNull();
    expect(screen.queryByText(/could not be asked/)).toBeNull();
    expect(screen.queryByText(/of 4/)).toBeNull();
  });
});

describe("a ready machine with gaps (Y-714)", () => {
  const all = [
    "reachable", "sshd", "tmux", "git", "agent-cli", "terminfo",
    "provider-cli", "provider-auth", "login-session", "folder-access", "hooks", "heartbeat",
  ].map((name): Check => ({ check: name, state: "present", detail: "that machine knows `xterm-256color`" }));
  const gaps: Check[] = [
    { check: "no-sudo", state: "absent", detail: "the account is in the wheel group" },
    { check: "hooks", state: "absent", detail: "no `hooks` file" },
  ];
  const checks = [...all.filter((one) => one.check !== "hooks"), ...gaps];

  it("lists the failing checks and none that pass", async () => {
    renderCard(aMachine(), checks);
    await screen.findByText(/to fix/);
    expect(screen.queryByText("ssh")).toBeNull();
    expect(screen.queryByText("tmux")).toBeNull();
    expect(screen.queryByText("terminfo")).toBeNull();
    expect(screen.queryByText("ok")).toBeNull();
    expect(screen.getByText("hook command not on PATH")).toBeTruthy();
  });

  it("shows the sudo gap once, in its note, and keeps the other gaps as lines", async () => {
    renderCard(aMachine(), checks);
    await screen.findByText(/to fix/);
    expect(screen.queryByText(/wheel group/)).toBeNull();
    const said = screen.getAllByText("Agents here can use sudo");
    expect(said).toHaveLength(1);
    expect(said[0].getAttribute("role")).toBe("note");
    expect(screen.queryByText("The joined account can use sudo")).toBeNull();
    expect(screen.getByText("hook command not on PATH")).toBeTruthy();
    const filled = Array.from(document.body.querySelectorAll("button, a")).filter((one) =>
      /filled/.test(one.className),
    );
    expect(filled.length).toBeLessThanOrEqual(1);
  });

  it("prints no backticks", async () => {
    renderCard(aMachine(), [...all.filter((one) => one.check !== "terminfo"), { check: "terminfo", state: "absent", detail: "that machine lacks `xterm-256color`" }]);
    await screen.findByText("lacks xterm-256color");
    expect(document.body.textContent).not.toContain("`");
    // Y-733: a failing row is its short cause, with no daemon paragraph and no Fix on the card.
    expect(document.body.textContent).not.toContain("that machine lacks");
    expect(screen.queryByRole("button", { name: /^Fix/ })).toBeNull();
  });
});
