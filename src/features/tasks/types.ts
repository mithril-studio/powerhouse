export type TaskColumn =
  | "backlog"
  | "running"
  | "attention"
  | "review"
  | "done";
export type TurnOutcome =
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";
export interface Task {
  id: string;
  repoId: string;
  title: string;
  description: string;
  agentId: string;
  branchId: string | null;
  primaryChatId: string | null;
  source?: { repository: string; number: number; url: string };
  cloudRunId?: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  seenAt: number;
  archivedAt: number | null;
  parked?: boolean;
  launch: {
    stage: "not_started" | "preparing" | "ready" | "failed" | "interrupted";
    attemptId?: string;
    branchName?: string;
    error?: string;
  };
  turn?: { outcome: TurnOutcome; at: number; summary?: string };
  completion?: {
    kind: "manual" | "merged";
    at: number;
    queueId?: string;
    commit?: string;
    sourceSha?: string;
  };
  queueId?: string;
  lastWorkAt: number;
}
export interface SessionActivity {
  connection: "idle" | "starting" | "ready" | "error" | "exited";
  busy: boolean;
  canceling?: boolean;
  permissionCount: number;
  error: string | null;
}
export const TASK_COLUMNS: { id: TaskColumn; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "running", label: "In Progress" },
  { id: "attention", label: "Needs You" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

export interface TaskFacts {
  head: string;
  dirty: boolean;
  changed_files: number;
}
