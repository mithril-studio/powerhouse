import { describe, expect, it } from "vitest";
import type { DigestReport, RunSummary, TaskRow } from "./ipc";
import {
  coverageBadges,
  digestToMarkdown,
  fmtCost,
  fmtDuration,
  fmtMetricSample,
  fmtTokens,
  fmtWhen,
  runStatus,
  taskOutcome,
  usageCoveragePct,
} from "./telemetryFormat";

const baseTask: TaskRow = {
  repoKey: "repo-1",
  repoLabel: "powerhouse",
  branch: "feat-x",
  agentRuns: 2,
  turns: 5,
  toolCalls: 9,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  instrumentedRuns: 2,
  runsWithUsage: 0,
  models: null,
  lastAgentAt: 1_000,
  queueAttempts: 0,
  delivered: false,
  firstPassMerged: null,
  lastOutcome: null,
  lastQueueAt: null,
};

const base: RunSummary = {
  runId: "r1",
  source: "acp",
  coverage: "instrumented",
  chatId: "c1",
  providerSessionId: null,
  resumed: false,
  agentName: null,
  repoLabel: null,
  branchLabel: null,
  startedAt: 1_000,
  endedAt: null,
  exitCode: null,
  endReason: null,
  droppedEvents: 0,
  parseErrors: 0,
  usageEvents: 0,
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  costUsd: null,
  turnCount: 0,
  toolCallCount: 0,
  repoId: null,
  sourceSha: null,
  model: null,
  mode: null,
};

describe("runStatus", () => {
  it("derives each lifecycle state", () => {
    expect(runStatus(base)).toBe("running");
    expect(runStatus({ ...base, endedAt: 2_000, endReason: "exit", exitCode: 0 })).toBe("ok");
    expect(runStatus({ ...base, endedAt: 2_000, endReason: "exit", exitCode: 1 })).toBe("failed");
    expect(runStatus({ ...base, endedAt: 2_000, endReason: "killed" })).toBe("killed");
    expect(runStatus({ ...base, endedAt: 2_000, endReason: "app-shutdown" })).toBe("killed");
    expect(runStatus({ ...base, endReason: "interrupted" })).toBe("interrupted");
  });
});

describe("coverageBadges", () => {
  it("is empty for a clean instrumented run", () => {
    expect(coverageBadges(base)).toEqual([]);
  });

  it("surfaces every evidence gap", () => {
    expect(
      coverageBadges({
        ...base,
        coverage: "uninstrumented",
        endReason: "interrupted",
        resumed: true,
        droppedEvents: 3,
        parseErrors: 2,
      }),
    ).toEqual(["uninstrumented", "interrupted", "resumed", "3 dropped", "2 unparsed"]);
  });
});

describe("unknown-stays-unknown rendering", () => {
  it("renders null tokens and cost as em dash, never 0", () => {
    expect(fmtTokens(null)).toBe("—");
    expect(fmtTokens(undefined)).toBe("—");
    expect(fmtCost(null)).toBe("—");
    expect(fmtTokens(0)).toBe("0"); // a real observed zero is still a zero
  });

  it("abbreviates real token counts", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(12_340)).toBe("12.3k");
    expect(fmtTokens(2_500_000)).toBe("2.50M");
  });

  it("formats costs by magnitude", () => {
    expect(fmtCost(0.0123)).toBe("$0.0123");
    expect(fmtCost(1.5)).toBe("$1.50");
  });
});

describe("fmtDuration", () => {
  it("scales units", () => {
    expect(fmtDuration(450)).toBe("450ms");
    expect(fmtDuration(2_300)).toBe("2.3s");
    expect(fmtDuration(65_000)).toBe("1m 5s");
    expect(fmtDuration(120_000)).toBe("2m");
  });
});

describe("usageCoveragePct", () => {
  it("is unknown with no instrumented runs", () => {
    expect(usageCoveragePct(0, 0)).toBe("—");
  });
  it("reports the instrumented share with usage evidence", () => {
    expect(usageCoveragePct(4, 3)).toBe("75%");
  });
});

describe("taskOutcome", () => {
  it("only a merge counts as delivered", () => {
    expect(taskOutcome(baseTask)).toBe("unattempted");
    expect(taskOutcome({ ...baseTask, queueAttempts: 2 })).toBe("failed");
    expect(taskOutcome({ ...baseTask, queueAttempts: 2, delivered: true })).toBe("delivered");
  });
});

describe("fmtMetricSample", () => {
  it("always shows the denominator, and unknown values stay unknown", () => {
    expect(fmtMetricSample({ n: 12, value: 0.42 })).toBe("42% (n=12)");
    expect(fmtMetricSample({ n: 0, value: null })).toBe("— (n=0)");
    expect(fmtMetricSample(null)).toBe("— (n=0)");
  });
});

describe("digestToMarkdown", () => {
  const digest: DigestReport = {
    windowDays: 14,
    generatedAt: 1_700_000_000_000,
    tasksTotal: 3,
    tasksDelivered: 1,
    tasksFailed: 1,
    tasksUnattempted: 1,
    agentRuns: 5,
    interruptedRuns: 1,
    closedTurns: 20,
    errorTurns: 2,
    toolCalls: 40,
    toolFailures: 3,
    inputTokens: null,
    outputTokens: 12_340,
    costUsd: null,
    instrumentedRuns: 4,
    runsWithUsage: 2,
    uninstrumentedRuns: 1,
    droppedEvents: 0,
    parseErrors: 7,
    failures: [
      {
        kind: "queue-failure",
        repoLabel: "powerhouse",
        branch: "feat-x",
        detail: "tests failed",
        runId: "abcdef1234567890",
        at: 1_699_999_999_000,
      },
    ],
  };

  it("renders unknowns as em dash and cites run ids", () => {
    const md = digestToMarkdown(digest);
    expect(md).toContain("tokens in/out: —/12.3k, cost: —");
    expect(md).toContain("coverage: 2/4 instrumented runs reported usage");
    expect(md).toContain("[queue-failure] powerhouse/feat-x: tests failed (run abcdef12)");
    expect(md).toContain("delivered: 1, failed: 1, unattempted: 1");
    expect(md).not.toContain("cost: $0");
  });
});

describe("fmtWhen", () => {
  it("is relative below a day", () => {
    const now = 1_700_000_000_000;
    expect(fmtWhen(now - 30_000, now)).toBe("just now");
    expect(fmtWhen(now - 5 * 60_000, now)).toBe("5m ago");
    expect(fmtWhen(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(fmtWhen(now - 2 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
