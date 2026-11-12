import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { canStart, connectCommand, machinesProblem, machinesSummary, statusTone, type MachineRow } from "./machines";

const row = (name: string, status: string): MachineRow => ({ name, status, url: null, size: null, owned: name.startsWith("ph-") });

describe("machines", () => {
  it("summarises running against total", () => {
    expect(machinesSummary([row("a", "running"), row("b", "hibernated"), row("ph-c", "running")])).toBe("2 running · 3 total");
    expect(machinesSummary([])).toBe("0 running · 0 total");
  });

  it("only offers Start for machines at rest", () => {
    expect(canStart("stopped")).toBe(true);
    expect(canStart("hibernated")).toBe(true);
    expect(canStart("running")).toBe(false);
    expect(canStart("starting")).toBe(false);
  });

  it("colours transitions apart from on and off", () => {
    expect(statusTone("running")).toBe("on");
    expect(statusTone("starting")).toBe("busy");
    expect(statusTone("hibernated")).toBe("off");
  });

  it("turns the two setup errors into fixes and leaves the rest raw", () => {
    expect(machinesProblem("boxd is not authenticated: token expired")).toBe("signed-out");
    expect(machinesProblem("the boxd CLI is not installed. Install it from https://boxd.sh")).toBe("cli-missing");
    expect(machinesProblem("boxd: machine list: boom")).toBeNull();
    expect(machinesProblem(null)).toBeNull();
  });

  it("connects through the boxd CLI, not a raw ssh command", () => {
    expect(connectCommand("ph-x")).toBe("boxd connect ph-x");
  });
});
