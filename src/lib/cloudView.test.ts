import { describe, expect, it } from "vitest";
import type { CloudRunRecord, RunEvent } from "./cloud";
import { describeEvent, fmtAgo, latestActivity, presentMachine, presentRun } from "./cloudView";

const base = (over: Partial<CloudRunRecord>): CloudRunRecord => ({
  run_id: "r",
  repo_id: "repo",
  repo_path: "/x",
  repo_name: "x",
  source_branch: "main",
  manifest: {
    task: { text: "t", acceptance_criteria: [] },
    source: { commit_sha: "a".repeat(40), source_branch: "main", remote_url: "https://x/y.git" },
    output_branch: "powerhouse/cloud/r",
    checks: [],
    deadline_seconds: 600,
    agent: { provider: "claude", model: null, permission_mode: "dontAsk" },
  },
  manifest_digest: "d",
  created_at_ms: 0,
  phase: "accepted",
  phase_detail: null,
  task_vm: null,
  receipt: { state: "accepted", accepted_at_ms: 0, duplicate: false },
  snapshot: null,
  result: null,
  events: [],
  event_cursor: 0,
  last_sync_ms: null,
  last_sync_error: null,
  imported_worktree: null,
  machine: "active",
  machine_changed_ms: 0,
  park_snapshot: null,
  vm_released: false,
  diff_cached: null,
  remote_verified: false,
  machine_error: null,
  ...over,
});

const snap = (state: CloudRunRecord["snapshot"] extends infer S ? (S extends null ? never : S) : never) => state;

describe("presentRun", () => {
  it("does not promise detachment before acceptance", () => {
    expect(presentRun(base({ phase: "provisioning" })).detached).toBe(false);
    expect(presentRun(base({ phase: "submission_unknown" })).label).toBe("Submission outcome unknown");
    expect(presentRun(base({ phase: "submit_failed" })).tone).toBe("bad");
  });

  it("says safe to close only once accepted", () => {
    const p = presentRun(base({}));
    expect(p.detached).toBe(true);
    expect(p.detail).toMatch(/Safe to close/);
  });

  it("shows completed as ready for review, never merged, and reports absent checks honestly", () => {
    const r = base({
      snapshot: snap({
        run_id: "r", state: "completed", stage: null, last_event_seq: 1, accepted_at_ms: 0, updated_at_ms: 1,
        started_at_ms: null, finished_at_ms: 1, error: null, cancel_requested: false, result_available: true, unit_active: false,
      }),
      result: {
        run_id: "r", source_sha: "a", result_sha: "b", output_branch: "powerhouse/cloud/r", published: true, publish_error: null,
        summary: "done", concerns: [], checks_configured: false, checks: [], tree_changed_after_checks: false,
        changed_files: ["README.md"], diff_bytes: 10, diff_truncated: false, provider_session_id: null, usage: null,
        agent_exit_code: 0, partial_work_preserved: true,
      },
    });
    const p = presentRun(r);
    expect(p.label).toBe("Ready for review");
    expect(p.detail).toMatch(/No validation configured/);
    expect(p.label).not.toMatch(/Merged/);
  });

  it("keeps last-confirmed state while offline", () => {
    const r = base({
      last_sync_error: "boxd: timeout",
      snapshot: snap({
        run_id: "r", state: "running", stage: "agent", last_event_seq: 1, accepted_at_ms: 0, updated_at_ms: Date.now() - 120_000,
        started_at_ms: null, finished_at_ms: null, error: null, cancel_requested: false, result_available: false, unit_active: true,
      }),
    });
    const p = presentRun(r);
    expect(p.label).toBe("Agent working");
    expect(p.tone).toBe("warn");
    expect(p.detail).toMatch(/Offline — last confirmed 2m ago/);
  });

  it("surfaces the failing stage", () => {
    const r = base({
      snapshot: snap({
        run_id: "r", state: "failed", stage: "validating", last_event_seq: 1, accepted_at_ms: 0, updated_at_ms: 1,
        started_at_ms: null, finished_at_ms: 1, error: { stage: "validating", message: "check “unit” failed (exit 1)" },
        cancel_requested: false, result_available: true, unit_active: false,
      }),
    });
    expect(presentRun(r).detail).toBe("validating: check “unit” failed (exit 1)");
  });
});

describe("events", () => {
  const ev = (kind: string, payload: unknown, seq = 1): RunEvent => ({ seq, ts_ms: 0, kind, payload });

  it("describes assistant text and tool use, skips noise", () => {
    expect(describeEvent(ev("agent.assistant", { message: { content: [{ type: "text", text: "  Editing   README " }] } }))).toBe("Editing README");
    expect(describeEvent(ev("agent.assistant", { message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] } }))).toBe("Bash: pnpm test");
    expect(describeEvent(ev("run.claimed", {}))).toBeNull();
    expect(describeEvent(ev("agent.user", {}))).toBeNull();
  });

  it("picks the newest meaningful event", () => {
    const events = [
      ev("run.accepted", null, 1),
      ev("agent.assistant", { message: { content: [{ type: "text", text: "hello" }] } }, 2),
      ev("agent.user", {}, 3),
    ];
    expect(latestActivity(events)).toBe("hello");
    expect(latestActivity([])).toBeNull();
  });

  it("never turns prose into a completion claim", () => {
    const line = describeEvent(ev("agent.assistant", { message: { content: [{ type: "text", text: "Task complete, all checks passed!" }] } }));
    expect(line).toBe("Task complete, all checks passed!");
    // The label/tone come from state, not from this text.
    expect(presentRun(base({})).label).toBe("Accepted in cloud");
  });
});

describe("fmtAgo", () => {
  it("formats coarse durations", () => {
    const now = 1_000_000_000;
    expect(fmtAgo(now - 5_000, now)).toBe("5s ago");
    expect(fmtAgo(now - 90_000, now)).toBe("2m ago");
    expect(fmtAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});

describe("presentMachine", () => {
  it("names what boxd holds for the run", () => {
    expect(presentMachine(base({ machine: "active" })).label).toBe("VM active");
    const completed = base({
      machine: "active",
      snapshot: snap({
        run_id: "r", state: "completed", stage: null, last_event_seq: 1, accepted_at_ms: 0, updated_at_ms: 1,
        started_at_ms: null, finished_at_ms: 1, error: null, cancel_requested: false, result_available: true, unit_active: false,
      }),
      machine_error: "release pending: remote branch not verified yet",
    });
    const p = presentMachine(completed);
    expect(p.label).toBe("VM active · release pending");
    expect(p.detail).toMatch(/remote branch/);
    const now = 1_000_000_000;
    expect(presentMachine(base({ machine: "holding", machine_changed_ms: now - 18 * 60_000 }), now).label).toBe("VM held · parks in 42 min");
    expect(presentMachine(base({ machine: "parked", vm_released: true, park_snapshot: { name: "ph-r-park", version: "v1", size: "8.8G" } })).label).toBe(
      "Parked (snapshot 8.8G)",
    );
    expect(presentMachine(base({ machine: "released", vm_released: true })).label).toBe("Released");
    expect(presentMachine(base({ machine: "released", vm_released: false })).label).toBe("Releasing");
    expect(presentMachine(base({ machine: "unmanaged", task_vm: { name: "powerhouse-main", id: null } })).label).toBe("VM powerhouse-main not managed");
  });
});
