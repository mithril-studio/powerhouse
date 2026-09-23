import { createHash } from "node:crypto";

/**
 * A protocol-v3 script manifest for `powerhouse-runner`. Mirrors
 * `RunManifest` in cloud/protocol/src/lib.rs. Fields that Rust serializes
 * unconditionally (including defaults like `checks: []` and
 * `predecessor_run_id: null`) must be present here, because the digest is
 * computed over the canonical JSON on both sides.
 */
export interface ScriptManifest {
  protocol_version: 3;
  run_id: string;
  task: { text: string; acceptance_criteria: string[] };
  source: {
    repo_name: string;
    remote_url: string;
    commit_sha: string;
    source_branch: string | null;
  };
  output_branch: "";
  workspace: { base_snapshot: { name: string; version: string | null } };
  script: { command: string };
  checks: [];
  context: { brief_markdown: string };
  deadline_seconds: number;
  created_at_ms: number;
  predecessor_run_id: null;
}

export interface ManifestInputs {
  runId: string;
  taskText: string;
  repoName: string;
  remoteUrl: string;
  commitSha: string;
  snapshotName: string;
  snapshotVersion: string | null;
  command: string;
  deadlineSeconds: number;
  /** Persisted once per logical attempt; retries must reuse it so the digest is stable. */
  createdAtMs: number;
}

export function buildScriptManifest(input: ManifestInputs): ScriptManifest {
  return {
    protocol_version: 3,
    run_id: input.runId,
    task: { text: input.taskText, acceptance_criteria: [] },
    source: {
      repo_name: input.repoName,
      remote_url: input.remoteUrl,
      commit_sha: input.commitSha,
      source_branch: null,
    },
    output_branch: "",
    workspace: {
      base_snapshot: { name: input.snapshotName, version: input.snapshotVersion },
    },
    script: { command: input.command },
    checks: [],
    context: { brief_markdown: "" },
    deadline_seconds: input.deadlineSeconds,
    created_at_ms: input.createdAtMs,
    predecessor_run_id: null,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * SHA-256 of the canonical JSON encoding: object keys sorted, compact
 * separators. Matches `RunManifest::digest()` (serde_json's map is a sorted
 * BTreeMap and `to_vec` is compact). Manifests contain only strings,
 * integers, booleans and null, so number formatting is identical on both
 * sides.
 */
export function manifestDigest(manifest: ScriptManifest): string {
  const bytes = JSON.stringify(canonicalize(manifest));
  return createHash("sha256").update(bytes).digest("hex");
}
