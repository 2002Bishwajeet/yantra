import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

function renderCard(machine: Machine, checks: Check[], condensed = false) {
  const root = createRootRoute({
    component: () => (
      <MachineCard
        checks={checks}
        condensed={condensed}
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

  it.each([false, true])("warns, in words and not on hover, when agents can use sudo (condensed: %s)", async (condensed) => {
    renderCard(aMachine(), withSudo("absent", "the account is in the wheel group"), condensed);
    const note = await screen.findByRole("note");
    expect(note.textContent).toBe(
      "Agents here can use sudo: the account is in the wheel group. Join a separate account without sudo, named karigar.",
    );
  });

  it("says nothing when the account cannot use sudo", async () => {
    renderCard(aMachine(), withSudo("present", "there is no sudo here"));
    await screen.findByText("ssh");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says nothing when sudo could not be asked, because unknown is not absent", async () => {
    renderCard(aMachine(), withSudo("unknown", "could not be asked"));
    await screen.findByText("ssh");
    expect(screen.queryByRole("note")).toBeNull();
  });
});
