import { invoke } from "@tauri-apps/api/core";
import type { QueueEntry, WorkflowStep } from "../store/appStore";

export interface RepoInfo {
  root: string;
  name: string;
  default_branch: string;
}

export interface ChangedFile {
  path: string;
  status: string;
}

export const acpSpawn = (
  chatId: string,
  cwd: string,
  command: string,
  env?: Record<string, string>,
) => invoke<void>("acp_spawn", { chatId, cwd, command, env });

export const acpWrite = (chatId: string, data: string) =>
  invoke<void>("acp_write", { chatId, data });

export const acpKill = (chatId: string) => invoke<void>("acp_kill", { chatId });

export const acpKillAll = () => invoke<void>("acp_kill_all");

export const ptySpawn = (
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
  agentCmd?: string,
  resetTranscript = false,
) =>
  invoke<void>("pty_spawn", {
    sessionId,
    cwd,
    cols,
    rows,
    agentCmd: agentCmd ?? null,
    resetTranscript,
  });

/** Recorded output for a chat, for read-only replay after a restart. */
export const ptyReadTranscript = (sessionId: string) =>
  invoke<string>("pty_read_transcript", { sessionId });

export const ptyDeleteTranscript = (sessionId: string) =>
  invoke<void>("pty_delete_transcript", { sessionId });

export const ptyWrite = (sessionId: string, data: string) =>
  invoke<void>("pty_write", { sessionId, data });

export const ptyResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { sessionId, cols, rows });

export const ptyKill = (sessionId: string) =>
  invoke<void>("pty_kill", { sessionId });

export const ptyKillAll = () => invoke<void>("pty_kill_all");

export const gitValidateRepo = (path: string) =>
  invoke<RepoInfo>("git_validate_repo", { path });

/** Clone a git URL into `destParent` (default ~/conductor/repos) and validate it. */
export const gitCloneRepo = (url: string, destParent?: string | null) =>
  invoke<RepoInfo>("git_clone_repo", { url, destParent: destParent ?? null });

/** Create a new git project (init + initial commit) under `destParent`. */
export const gitInitRepo = (name: string, destParent?: string | null) =>
  invoke<RepoInfo>("git_init_repo", { name, destParent: destParent ?? null });

export const gitCreateWorktree = (repoPath: string, branch: string, base: string) =>
  invoke<string>("git_create_worktree", { repoPath, branch, base });

/** Local branch names for the repo, most-recently-committed first. */
export const gitListBranches = (repoPath: string) =>
  invoke<string[]>("git_list_branches", { repoPath });

export const gitRemoveWorktree = (repoPath: string, worktreePath: string) =>
  invoke<void>("git_remove_worktree", { repoPath, worktreePath });

export const gitChangedFiles = (worktreePath: string, base: string) =>
  invoke<ChangedFile[]>("git_changed_files", { worktreePath, base });

export const gitFileDiff = (worktreePath: string, base: string, path: string) =>
  invoke<string>("git_file_diff", { worktreePath, base, path });

export const gitListFiles = (worktreePath: string) =>
  invoke<string[]>("git_list_files", { worktreePath });

export const gitFileContent = (worktreePath: string, path: string) =>
  invoke<string>("git_file_content", { worktreePath, path });

export interface ImageFile {
  name: string;
  mimeType: string;
  /** Base64 payload, no data-URL prefix. */
  data: string;
  bytes: number;
}

/** Reads an image from disk for an ACP prompt; rejects non-images and >10 MB. */
export const readImageFile = (path: string) =>
  invoke<ImageFile>("read_image_file", { path });

// --- merge queue ---
type StepInput = Pick<WorkflowStep, "name" | "command" | "type">;

export const queueEnqueue = (
  repoId: string,
  repoPath: string,
  defaultBranch: string,
  branch: string,
  workflow: StepInput[],
  push: boolean,
) =>
  invoke<QueueEntry>("queue_enqueue", {
    repoId,
    repoPath,
    defaultBranch,
    branch,
    workflow,
    push,
  });

export const queueCancel = (repoId: string, entryId: string) =>
  invoke<void>("queue_cancel", { repoId, entryId });

export const queueState = (repoId: string) =>
  invoke<QueueEntry[]>("queue_state", { repoId });

export const queueStepLog = (repoId: string, entryId: string, step: number) =>
  invoke<string>("queue_step_log", { repoId, entryId, step });

export const queueDismiss = (repoId: string, entryId: string) =>
  invoke<void>("queue_dismiss", { repoId, entryId });

export interface HandoffEvent {
  branchId: string;
  path: string;
  relPath: string;
}

export const handoffEnsureCommands = () =>
  invoke<void>("handoff_ensure_commands");

export const handoffWatchStart = (branchId: string, worktreePath: string) =>
  invoke<void>("handoff_watch_start", { branchId, worktreePath });

export const handoffWatchStop = (branchId: string) =>
  invoke<void>("handoff_watch_stop", { branchId });

// --- telemetry ---
export interface RunSummary {
  runId: string;
  source: "acp" | "pty" | "queue";
  coverage: "instrumented" | "uninstrumented" | "process-only";
  chatId: string | null;
  providerSessionId: string | null;
  resumed: boolean;
  agentName: string | null;
  repoLabel: string | null;
  branchLabel: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  endReason: "exit" | "killed" | "app-shutdown" | "interrupted" | null;
  droppedEvents: number;
  parseErrors: number;
  usageEvents: number;
  /** null = unknown (no usage evidence), never zero. */
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  turnCount: number;
  toolCallCount: number;
  repoId: string | null;
  sourceSha: string | null;
  model: string | null;
  mode: string | null;
}

export interface TurnRow {
  turnIdx: number;
  promptSeq: number;
  promptPreview: string | null;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
}

export interface ToolCallRow {
  toolCallId: string;
  turnIdx: number | null;
  title: string | null;
  kind: string | null;
  status: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface RunDetail {
  run: RunSummary;
  turns: TurnRow[];
  toolCalls: ToolCallRow[];
  eventCount: number;
}

export interface TelemetryEventRow {
  seq: number;
  direction: "in" | "out" | "err" | "sys";
  ingestTime: number;
  method: string | null;
  updateKind: string | null;
  parseStatus: "ok" | "invalid-json" | "non-jsonrpc";
  replayed: boolean;
  truncated: boolean;
  rawPreview: string;
}

export interface TelemetryStats {
  totalRuns: number;
  activeRuns: number;
  failedRuns: number;
  interruptedRuns: number;
  uninstrumentedRuns: number;
  totalTurns: number;
  totalToolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  instrumentedRuns: number;
  runsWithUsage: number;
  droppedEvents: number;
  parseErrors: number;
}

export interface RebuildReport {
  runs: number;
  events: number;
}

export const telemetryListRuns = (
  limit: number,
  before?: number,
  source?: RunSummary["source"],
) =>
  invoke<RunSummary[]>("telemetry_list_runs", {
    limit,
    before: before ?? null,
    source: source ?? null,
  });

export const telemetryRunDetail = (runId: string) =>
  invoke<RunDetail>("telemetry_run_detail", { runId });

export const telemetryRunEvents = (runId: string, offset: number, limit: number) =>
  invoke<TelemetryEventRow[]>("telemetry_run_events", { runId, offset, limit });

export const telemetryStats = () => invoke<TelemetryStats>("telemetry_stats");

export const telemetryRebuild = () =>
  invoke<RebuildReport>("telemetry_rebuild");

export interface CheckResult {
  id: string;
  label: string;
  status: "pass" | "fail" | "info";
  detail: string;
}

/** Live invariant battery — read-only, safe to poll while using the app. */
export const telemetrySelfcheck = () =>
  invoke<CheckResult[]>("telemetry_selfcheck");

export const telemetryAnnotateRun = (
  chatId: string,
  labels: {
    agentName?: string;
    agentVersion?: string;
    repoId?: string;
    repoLabel?: string;
    branchLabel?: string;
    model?: string;
  },
) =>
  invoke<void>("telemetry_annotate_run", {
    chatId,
    agentName: labels.agentName ?? null,
    agentVersion: labels.agentVersion ?? null,
    repoId: labels.repoId ?? null,
    repoLabel: labels.repoLabel ?? null,
    branchLabel: labels.branchLabel ?? null,
    model: labels.model ?? null,
  });

// --- telemetry: tasks & digest (milestone 2) ---
export interface TaskRow {
  repoKey: string;
  repoLabel: string | null;
  branch: string;
  agentRuns: number;
  turns: number;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  instrumentedRuns: number;
  runsWithUsage: number;
  models: string | null;
  lastAgentAt: number | null;
  queueAttempts: number;
  delivered: boolean;
  firstPassMerged: boolean | null;
  lastOutcome: "merged" | "failed" | "canceled" | null;
  lastQueueAt: number | null;
}

export interface FailureItem {
  kind: "queue-failure" | "error-turn";
  repoLabel: string | null;
  branch: string | null;
  detail: string;
  runId: string;
  at: number;
}

export interface DigestReport {
  windowDays: number;
  generatedAt: number;
  tasksTotal: number;
  tasksDelivered: number;
  tasksFailed: number;
  tasksUnattempted: number;
  agentRuns: number;
  interruptedRuns: number;
  closedTurns: number;
  errorTurns: number;
  toolCalls: number;
  toolFailures: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  instrumentedRuns: number;
  runsWithUsage: number;
  uninstrumentedRuns: number;
  droppedEvents: number;
  parseErrors: number;
  failures: FailureItem[];
}

export const telemetryTasks = (windowDays: number) =>
  invoke<TaskRow[]>("telemetry_tasks", { windowDays });

export const telemetryDigest = (windowDays: number) =>
  invoke<DigestReport>("telemetry_digest", { windowDays });

// --- telemetry: proposal ledger (milestone 3) ---
export const PROPOSAL_METRICS = [
  { key: "merge_rate", label: "Merge rate", higherIsBetter: true },
  { key: "first_pass_merge_rate", label: "First-pass merge rate", higherIsBetter: true },
  { key: "error_turn_rate", label: "Error turn rate", higherIsBetter: false },
  { key: "tool_failure_rate", label: "Tool failure rate", higherIsBetter: false },
] as const;

export type ProposalMetric = (typeof PROPOSAL_METRICS)[number]["key"];

export interface MetricSample {
  /** Denominator: how many observations the value rests on. */
  n: number;
  value: number | null;
}

export interface Evaluation {
  baseline: MetricSample;
  evaluation: MetricSample;
  verdict: "improved" | "regressed" | "unchanged" | "insufficient-evidence";
  computedAt: number;
}

export type ProposalStatus = "proposed" | "adopted" | "kept" | "reverted" | "retired";

export interface Proposal {
  proposalId: string;
  createdAt: number;
  title: string;
  hypothesis: string;
  target: string;
  metric: ProposalMetric;
  repoId: string | null;
  evidenceRunIds: string[];
  minSamples: number;
  status: ProposalStatus;
  adoptedAt: number | null;
  decidedAt: number | null;
  decisionNote: string | null;
  baseline: MetricSample | null;
  evaluation: Evaluation | null;
}

export const proposalCreate = (input: {
  title: string;
  hypothesis: string;
  target: string;
  metric: ProposalMetric;
  repoId?: string;
  evidenceRunIds?: string[];
  minSamples?: number;
}) =>
  invoke<Proposal>("telemetry_proposal_create", {
    title: input.title,
    hypothesis: input.hypothesis,
    target: input.target,
    metric: input.metric,
    repoId: input.repoId ?? null,
    evidenceRunIds: input.evidenceRunIds ?? [],
    minSamples: input.minSamples ?? 5,
  });

export const proposalList = () => invoke<Proposal[]>("telemetry_proposal_list");

export const proposalAdopt = (proposalId: string) =>
  invoke<Proposal>("telemetry_proposal_adopt", { proposalId });

export const proposalEvaluate = (proposalId: string) =>
  invoke<Proposal>("telemetry_proposal_evaluate", { proposalId });

export const proposalDecide = (
  proposalId: string,
  decision: "kept" | "reverted" | "retired",
  note?: string,
) =>
  invoke<Proposal>("telemetry_proposal_decide", {
    proposalId,
    decision,
    note: note ?? null,
  });

// --- GitHub OAuth (device flow) ---
export interface DeviceStart {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
  expires_in: number;
}

export interface GithubAccount {
  login: string;
  avatar_url: string;
}

/** One poll tick's outcome. The token never crosses this boundary — it stays
 *  in the Rust keychain; only the display profile comes back on success. */
export type PollResult =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | ({ status: "connected" } & GithubAccount);

export const githubDeviceStart = () =>
  invoke<DeviceStart>("github_device_start");

export const githubPoll = (deviceCode: string) =>
  invoke<PollResult>("github_poll", { deviceCode });

export const githubAccount = () =>
  invoke<GithubAccount | null>("github_account");

/** A repository the signed-in user can clone. */
export interface GithubRepoSummary {
  full_name: string;
  clone_url: string;
  private: boolean;
}

/** Repos the signed-in user can access, newest first (for Add-project autocomplete). */
export const githubListRepos = () =>
  invoke<GithubRepoSummary[]>("github_list_repos");

export const githubDisconnect = () => invoke<void>("github_disconnect");
