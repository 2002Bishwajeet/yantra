import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Check } from "@/api";
import { aMachine } from "@/api/fixtures";
import { MachineCard } from "./MachineCard";

afterEach(cleanup);

const present = (name: string): Check => ({
  check: name,
  state: "present",
  detail: "ok",
});

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
      "heartbeat",
    ].map(present);
    checks.push({
      check: "mic",
      state: "absent",
      detail: "not installed — the microphone is optional",
    });
    const root = createRootRoute({
      component: () => (
        <MachineCard
          checks={checks}
          condensed={false}
          machine={aMachine()}
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
    await screen.findByText("ready");
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("12 of 13")).toBeTruthy();
    expect(screen.queryByText(/failing/)).toBeNull();
  });
});
