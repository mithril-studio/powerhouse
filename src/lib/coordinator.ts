import { invoke } from "@tauri-apps/api/core";
import type { WorkflowDraft } from "../features/workflows/workflowDrafts";

/** Mirror of the server's run/node states (server/src/runs.ts). */
export type RunStatus =
  | "pending_dispatch"
  | "dispatched"
  | "running"
  | "succeeded"
  | "failed"
  | "canceling"
  | "canceled";

export type NodeState =
  | "pending"
  | "provisioning"
  | "submitting"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted"
  | "skipped";

export interface RunNodeView {
  nodeIndex: number;
  jobId: string;
  state: NodeState;
  machineName: string | null;
  exitCode: number | null;
  outputTail: string | null;
  error: string | null;
}

export interface RunDetail {
  run: {
    id: string;
    status: RunStatus;
    cancelRequested: boolean;
    repoName: string;
    commitSha: string;
    workflowId: string | null;
    workflowVersion: number | null;
    nodes: { name: string; command: string }[];
    error: string | null;
    createdAt: string;
    updatedAt: string;
  };
  nodes: RunNodeView[];
}

interface CoordinatorResponse {
  status: number;
  body: Record<string, unknown> | null;
}

export interface RepoHead {
  remote_url: string;
  commit_sha: string;
  default_branch: string;
}

const TERMINAL: RunStatus[] = ["succeeded", "failed", "canceled"];

export const isTerminal = (status: RunStatus): boolean => TERMINAL.includes(status);

/** Kebab-case a free-form name into the server's node/workflow charset. */
export function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : fallback;
}

/**
 * Draft steps → server nodes: slugified names, made unique with -2/-3…
 * suffixes. Returns an error message instead when a command is empty.
 */
export function draftToNodes(draft: WorkflowDraft): { name: string; command: string }[] | string {
  if (draft.steps.length === 0) return "add at least one script before publishing";
  const seen = new Map<string, number>();
  const nodes = [];
  for (const [i, step] of draft.steps.entries()) {
    if (step.command.trim().length === 0) {
      return `script ${i + 1} (${step.name.trim() || "untitled"}) has no command`;
    }
    const base = slugify(step.name, `script-${i + 1}`);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const name = n === 1 ? base : `${base.slice(0, 60)}-${n}`;
    nodes.push({ name, command: step.command });
  }
  return nodes;
}

/** Fingerprint of what publishing would send — detects unpublished edits. */
export const draftContentKey = (draft: WorkflowDraft): string =>
  JSON.stringify(draft.steps.map((s) => [s.name, s.command]));

const request = (baseUrl: string, method: "GET" | "POST", path: string, body?: unknown) =>
  invoke<CoordinatorResponse>("coordinator_request", { baseUrl, method, path, body });

/** Human-readable error out of a non-2xx coordinator response. */
const apiError = (r: CoordinatorResponse, fallback: string): string =>
  typeof r.body?.error === "string" ? (r.body.error as string) : `${fallback} (HTTP ${r.status})`;

export const coordinatorHealthy = async (baseUrl: string): Promise<boolean> => {
  try {
    return (await request(baseUrl, "GET", "/health")).status === 200;
  } catch {
    return false;
  }
};

export const tokenStored = () => invoke<boolean>("coordinator_token_status");
export const storeToken = (token: string) => invoke<void>("coordinator_set_token", { token });

export const repoHead = (repoPath: string) =>
  invoke<RepoHead>("coordinator_repo_head", { repoPath });

/**
 * Publish a draft: first publish creates the server workflow, later ones add
 * a version. Returns the server ids to pin on the draft.
 */
export async function publishDraft(
  baseUrl: string,
  draft: WorkflowDraft,
  repoPath: string,
  snapshotName: string,
): Promise<{ workflowId: string; version: number }> {
  const nodes = draftToNodes(draft);
  if (typeof nodes === "string") throw new Error(nodes);
  const head = await repoHead(repoPath);
  const content = {
    remoteUrl: head.remote_url,
    snapshot: { name: snapshotName },
    nodes,
  };
  if (draft.serverWorkflowId) {
    const r = await request(baseUrl, "POST", `/v1/workflows/${draft.serverWorkflowId}/versions`, content);
    if (r.status === 201) {
      return { workflowId: draft.serverWorkflowId, version: r.body?.version as number };
    }
    if (r.status !== 404) throw new Error(apiError(r, "publish failed"));
    // The server no longer knows this workflow (e.g. a fresh database) —
    // fall through and create it again.
  }
  const name = slugify(draft.name, `workflow-${draft.id.slice(0, 8)}`);
  const r = await request(baseUrl, "POST", "/v1/workflows", { name, ...content });
  if (r.status !== 201) throw new Error(apiError(r, "publish failed"));
  return { workflowId: r.body?.workflowId as string, version: r.body?.version as number };
}

/** Start a run of the draft's last published version at the remote's head. */
export async function startRun(baseUrl: string, draft: WorkflowDraft, repoPath: string): Promise<string> {
  if (!draft.serverWorkflowId || !draft.publishedVersion) throw new Error("publish this workflow first");
  const head = await repoHead(repoPath);
  const r = await request(baseUrl, "POST", `/v1/workflows/${draft.serverWorkflowId}/runs`, {
    version: draft.publishedVersion,
    commitSha: head.commit_sha,
    idempotencyKey: crypto.randomUUID(),
  });
  if (r.status !== 202 && r.status !== 200) throw new Error(apiError(r, "run failed to start"));
  return r.body?.runId as string;
}

export async function getRun(baseUrl: string, runId: string): Promise<RunDetail> {
  const r = await request(baseUrl, "GET", `/v1/runs/${runId}`);
  if (r.status !== 200) throw new Error(apiError(r, "run lookup failed"));
  return r.body as unknown as RunDetail;
}

export async function cancelRun(baseUrl: string, runId: string): Promise<void> {
  const r = await request(baseUrl, "POST", `/v1/runs/${runId}/cancel`);
  if (r.status !== 200) throw new Error(apiError(r, "cancel failed"));
}
