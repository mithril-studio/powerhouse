// Pure presentation helpers for cloud runs (unit-tested; no Tauri imports).
import { isTerminal, type CloudRunRecord, type RunEvent, type RunState } from "./cloud";

export type Tone = "live" | "ok" | "bad" | "muted" | "warn";

export interface RunPresentation {
  label: string;
  tone: Tone;
  /** Short explanation shown under the label. */
  detail: string | null;
  /** Whether "close your laptop" is honest right now. */
  detached: boolean;
}

export const STATE_LABEL: Record<RunState, string> = {
  accepted: "Accepted in cloud",
  preparing: "Preparing workspace",
  running: "Agent working",
  validating: "Running checks",
  publishing: "Publishing",
  completed: "Ready for review",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function presentRun(r: CloudRunRecord): RunPresentation {
  switch (r.phase) {
    case "submitting":
    case "provisioning":
      return {
        label: "Preparing cloud environment",
        tone: "live",
        detail: r.phase_detail ?? "Not yet accepted — keep the app open.",
        detached: false,
      };
    case "submission_unknown":
      return {
        label: "Submission outcome unknown",
        tone: "warn",
        detail: r.phase_detail ?? "Reconnecting to confirm whether the run was accepted.",
        detached: false,
      };
    case "submit_failed":
      return {
        label: "Not submitted",
        tone: "bad",
        detail: r.phase_detail ?? "The run never reached the cloud.",
        detached: false,
      };
    case "accepted": {
      const state = r.snapshot?.state ?? r.receipt?.state ?? "accepted";
      const err = r.snapshot?.error;
      let detail: string | null = null;
      if (state === "accepted") detail = "Safe to close your laptop.";
      else if (state === "completed") {
        const res = r.result;
        detail = res
          ? res.checks_configured
            ? `${res.checks.filter((c) => c.status === "passed").length}/${res.checks.length} checks passed · ${res.changed_files.length} files changed`
            : `No validation configured · ${res.changed_files.length} files changed`
          : "Fetching result…";
      } else if (err) detail = `${err.stage}: ${err.message}`;
      else if (state === "cancelled") detail = "Processes confirmed stopped; partial work kept in the cloud.";
      else if (r.snapshot?.cancel_requested) detail = "Cancel requested — waiting for the runner to confirm.";
      if (r.last_sync_error) {
        detail = `Offline — last confirmed ${fmtAgo(r.snapshot?.updated_at_ms ?? r.receipt?.accepted_at_ms ?? r.created_at_ms)}${detail ? ` · ${detail}` : ""}`;
      }
      return {
        label: STATE_LABEL[state],
        tone:
          state === "completed"
            ? "ok"
            : state === "failed" || state === "interrupted" || state === "blocked"
              ? "bad"
              : state === "cancelled"
                ? "muted"
                : r.last_sync_error
                  ? "warn"
                  : "live",
        detail,
        detached: true,
      };
    }
  }
}

export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** One-line description of the newest meaningful event. */
export function latestActivity(events: RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const line = describeEvent(events[i]);
    if (line) return line;
  }
  return null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" ? (v as Obj) : null);
const str = (v: unknown, cap = 160): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
};

/** Human line for an event, or null for noise. */
export function describeEvent(e: RunEvent): string | null {
  const p = obj(e.payload) ?? {};
  switch (e.kind) {
    case "run.accepted":
      return "Accepted by the runner";
    case "run.stage":
      return `Stage: ${String(p.stage ?? p.state ?? "")}`;
    case "workspace.fetch":
      return `Fetching ${String(p.sha ?? "").slice(0, 7)} from remote`;
    case "workspace.ready":
      return `Workspace ready at ${String(p.sha ?? "").slice(0, 7)}`;
    case "agent.started":
      return "Agent started";
    case "agent.assistant": {
      const msg = obj(p.message);
      const content = Array.isArray(msg?.content) ? (msg!.content as unknown[]) : [];
      for (const part of content) {
        const c = obj(part);
        if (!c) continue;
        if (c.type === "text") {
          const t = str(c.text);
          if (t) return t;
        }
        if (c.type === "tool_use") {
          const input = obj(c.input);
          const hint =
            str(input?.command, 80) ?? str(input?.file_path, 80) ?? str(input?.path, 80) ?? str(input?.pattern, 80);
          return `${String(c.name ?? "tool")}${hint ? `: ${hint}` : ""}`;
        }
      }
      return null;
    }
    case "agent.result":
      return p.subtype === "success" ? "Agent finished" : `Agent stopped: ${String(p.subtype ?? "unknown")}`;
    case "agent.exited":
      return p.exit_code == null ? "Agent process ended" : `Agent exited (${String(p.exit_code)})`;
    case "agent.stopping":
      return `Stopping agent: ${String(p.reason ?? "")}`;
    case "check.started":
      return `Check: ${String(p.name || p.command || "")}`;
    case "check.finished":
      return `Check ${String(p.name || "")} ${String(p.status)}${p.exit_code != null ? ` (exit ${String(p.exit_code)})` : ""}`;
    case "checks.none_configured":
      return "No validation configured";
    case "publish.done":
      return `Published ${String(p.result_sha ?? "").slice(0, 7)} to ${String(p.branch ?? "")}`;
    case "publish.error":
    case "publish.skipped":
      return `Publication problem: ${String(p.message ?? p.reason ?? "")}`;
    case "run.cancel_requested":
      return "Cancel requested";
    case "run.finished":
      return `Finished: ${String(p.state ?? "")}`;
    case "run.reconciled":
      return `Reconciled after supervisor loss (${String(p.reason ?? "")})`;
    case "output.truncated":
      return `Output truncated: ${String(p.dropped_events ?? "?")} events dropped (raw log kept on the VM)`;
    default:
      return e.kind.startsWith("agent.") || e.kind.startsWith("snapshot.") || e.kind === "run.claimed" || e.kind === "run.launched" || e.kind === "run.executor_started" || e.kind === "unit.finished"
        ? null
        : e.kind;
  }
}

export const shortSha = (s: string | null | undefined) => (s ? s.slice(0, 7) : "");

// --- machine lifecycle ----------------------------------------------------------

/** Mirrors the backend's default hold before a non-completed run is parked. */
export const HOLD_MINUTES = 60;

export interface MachinePresentation {
  label: string;
  tone: Tone;
  /** Lifecycle problem or pending reason, if any. */
  detail: string | null;
}

/** One-line description of what boxd holds for this run. */
export function presentMachine(r: CloudRunRecord, now = Date.now()): MachinePresentation {
  const detail = r.machine_error;
  switch (r.machine) {
    case "provisioning":
      return { label: "VM starting", tone: "live", detail };
    case "active": {
      const state = r.snapshot?.state ?? r.receipt?.state;
      const pending = !!state && isTerminal(state);
      return { label: pending ? "VM active · release pending" : "VM active", tone: pending ? "warn" : "live", detail };
    }
    case "holding": {
      const left = Math.max(0, Math.round((r.machine_changed_ms + HOLD_MINUTES * 60_000 - now) / 60_000));
      return { label: left > 0 ? `VM held · parks in ${left} min` : "VM held · parking", tone: "warn", detail };
    }
    case "parked": {
      const size = r.park_snapshot?.size ? ` ${r.park_snapshot.size}` : "";
      return { label: `Parked (snapshot${size})`, tone: "muted", detail };
    }
    case "restoring":
      return { label: "Restoring VM", tone: "live", detail };
    case "released":
      return { label: r.park_snapshot || !r.vm_released ? "Releasing" : "Released", tone: "muted", detail };
    case "unmanaged":
      return { label: r.task_vm ? `VM ${r.task_vm.name} not managed` : "No VM", tone: "muted", detail };
  }
}
