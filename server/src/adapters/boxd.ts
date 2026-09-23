import { Boxd, NotFoundError } from "@boxd-sh/sdk";

import { manifestDigest } from "../manifest.js";
import {
  AdapterTransportError,
  ManifestConflictError,
  machineNameForJob,
  type ExecutionAdapter,
  type JobReceipt,
  type JobRequest,
  type JobSnapshot,
  type JobState,
  type MachineReceipt,
  type MachineRequest,
} from "./types.js";

const RUNNER_BIN = "/usr/local/bin/powerhouse-runner";
/** Only machines with this prefix are ours to create or destroy. */
const OWNED_PREFIX = "ph-";
const EXEC_TIMEOUT_MS = 60_000;
const SUBMIT_TIMEOUT_MS = 90_000;

interface RunnerEnvelope {
  ok?: unknown;
  error?: { code?: string; message?: string };
}

/** Scavenge the first JSON value out of possibly noisy CLI output. */
function extractJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) throw new AdapterTransportError(`runner returned no JSON: ${text.slice(0, 400)}`);
  return JSON.parse(text.slice(start));
}

function ensureOwned(name: string): void {
  if (!name.startsWith(OWNED_PREFIX) || name.length <= OWNED_PREFIX.length + 1 || !/^[A-Za-z0-9-]+$/.test(name)) {
    throw new Error(`refusing to manage machine ${name}: not a Powerhouse-owned name`);
  }
}

function mapRunState(state: string): JobState {
  switch (state) {
    case "accepted":
      return "accepted";
    case "preparing":
      return "preparing";
    case "running":
    case "validating":
    case "publishing":
      return "running";
    case "completed":
      return "completed";
    case "blocked":
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    default:
      throw new AdapterTransportError(`runner reported unknown state ${state}`);
  }
}

/**
 * Real execution transport: boxd microVMs supervised by `powerhouse-runner`.
 *
 * Invariants carried over from the desktop implementation
 * (src-tauri/src/cloud/commands.rs):
 * - reconcile machine creation by NAME, never by list — the caller persists
 *   the intended name before this adapter runs, and absence of an
 *   acknowledgement is not absence of a machine;
 * - machines are isolated with auto-suspend/hibernate disabled, because
 *   idle timers follow inbound traffic, not CPU work;
 * - `submit` failures are resolved through `inspect` (the runner is
 *   idempotent per run_id + digest);
 * - a VM is only deleted by its recorded machine id, with the `ph-` name
 *   guard re-checked.
 */
export class BoxdExecutionAdapter implements ExecutionAdapter {
  private readonly boxd: Boxd;
  /** jobId → machine id, rebuilt lazily; the durable copy lives in Postgres. */
  private readonly machineIds = new Map<string, string>();

  constructor(boxd?: Boxd) {
    this.boxd = boxd ?? new Boxd();
  }

  async ensureMachine(input: MachineRequest): Promise<MachineReceipt> {
    ensureOwned(input.name);
    try {
      const existing = await this.boxd.machines.get(input.name);
      return { machineId: existing.id, name: existing.name, created: false };
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw new AdapterTransportError(`machine lookup ${input.name}: ${String(err)}`);
      }
    }
    try {
      const machine = await this.boxd.machines.create({
        fromSnapshot: input.snapshotName,
        name: input.name,
        isolated: true,
        config: { autoSuspendTimeout: 0 },
      });
      const ready = await this.boxd.machines.waitUntilReady(machine.id, { timeout: 180_000 });
      await this.verifyRunner(ready.id, input);
      return { machineId: ready.id, name: ready.name, created: true };
    } catch (err) {
      // The create may have landed even though the response was lost.
      try {
        const adopted = await this.boxd.machines.get(input.name);
        const ready = await this.boxd.machines.waitUntilReady(adopted.id, { timeout: 180_000 });
        await this.verifyRunner(ready.id, input);
        return { machineId: ready.id, name: ready.name, created: true };
      } catch {
        throw new AdapterTransportError(`machine create ${input.name}: ${String(err)}`);
      }
    }
  }

  private async verifyRunner(machineId: string, input: MachineRequest): Promise<void> {
    const probe = (await this.runner(machineId, ["probe"], EXEC_TIMEOUT_MS)) as {
      script_protocol_version?: number;
    };
    if (probe.script_protocol_version !== 3) {
      throw new Error(
        `snapshot ${input.snapshotName} runner does not support script jobs ` +
          `(script_protocol_version=${probe.script_protocol_version ?? "absent"}); publish a new snapshot`,
      );
    }
  }

  async submitJob(input: JobRequest): Promise<JobReceipt> {
    const machineId = await this.resolveMachineId(input.machineName);
    const digest = manifestDigest(input.manifest);
    const manifestPath = `/home/boxd/powerhouse-${input.jobId}.json`;
    await this.boxd.machines.files.upload(machineId, manifestPath, JSON.stringify(input.manifest));

    const args = ["submit", "--manifest", manifestPath, "--expect-digest", digest];
    if (input.credentials && Object.keys(input.credentials).length > 0) {
      const credsPath = `/home/boxd/powerhouse-${input.jobId}.creds`;
      const lines = Object.entries(input.credentials)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      await this.boxd.machines.files.upload(machineId, credsPath, `${lines}\n`);
      args.push("--credentials", credsPath);
    }

    try {
      const receipt = (await this.runner(machineId, args, SUBMIT_TIMEOUT_MS)) as {
        run_id: string;
        manifest_digest: string;
        state: string;
        duplicate: boolean;
      };
      if (receipt.manifest_digest !== digest) {
        throw new ManifestConflictError(
          `job ${input.jobId}: runner holds digest ${receipt.manifest_digest}, submitted ${digest}`,
        );
      }
      return {
        jobId: input.jobId,
        manifestDigest: digest,
        state: mapRunState(receipt.state),
        duplicate: receipt.duplicate,
      };
    } catch (err) {
      if (err instanceof ManifestConflictError) throw err;
      if (err instanceof RunnerCommandError && err.code === "conflict") {
        throw new ManifestConflictError(`job ${input.jobId}: ${err.message}`);
      }
      // Absence of a response is not absence of a run: resolve via inspect.
      const snapshot = await this.tryInspect(machineId, input.jobId);
      if (snapshot) {
        return { jobId: input.jobId, manifestDigest: digest, state: snapshot.state, duplicate: true };
      }
      throw new AdapterTransportError(`submit ${input.jobId}: ${String(err)}`);
    }
  }

  async inspectJob(jobId: string): Promise<JobSnapshot> {
    const machineId = await this.resolveMachineId(machineNameForJob(jobId));
    const snapshot = await this.tryInspect(machineId, jobId);
    if (!snapshot) throw new AdapterTransportError(`inspect ${jobId}: runner has no such run`);
    return snapshot;
  }

  private async tryInspect(machineId: string, jobId: string): Promise<JobSnapshot | null> {
    let raw: unknown;
    try {
      raw = await this.runner(machineId, ["inspect", jobId], EXEC_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof RunnerCommandError && err.code === "not_found") return null;
      throw new AdapterTransportError(`inspect ${jobId}: ${String(err)}`);
    }
    const snap = raw as {
      state: string;
      unit_active?: boolean | null;
      error?: { stage: string; message: string } | null;
      result_available: boolean;
    };
    const state = mapRunState(snap.state);
    let exitCode: number | null = null;
    let outputTail = "";
    if (snap.result_available) {
      try {
        const result = (await this.runner(machineId, ["result", jobId], EXEC_TIMEOUT_MS)) as {
          script?: { exit_code: number | null; output_tail: string };
        };
        exitCode = result.script?.exit_code ?? null;
        outputTail = result.script?.output_tail ?? "";
      } catch {
        // Result fetch is best-effort; the snapshot alone is still authoritative.
      }
    }
    return {
      jobId,
      state,
      unitActive: snap.unit_active ?? null,
      exitCode,
      outputTail,
      error: snap.error ? `${snap.error.stage}: ${snap.error.message}` : null,
    };
  }

  async cancelJob(jobId: string): Promise<void> {
    const machineId = await this.resolveMachineId(machineNameForJob(jobId));
    try {
      await this.runner(machineId, ["cancel", jobId], EXEC_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof RunnerCommandError && err.code === "not_found") return;
      throw new AdapterTransportError(`cancel ${jobId}: ${String(err)}`);
    }
  }

  async releaseMachine(machineId: string): Promise<void> {
    let machine;
    try {
      machine = await this.boxd.machines.get(machineId);
    } catch (err) {
      if (err instanceof NotFoundError) return; // already gone — release is idempotent
      throw new AdapterTransportError(`release lookup ${machineId}: ${String(err)}`);
    }
    ensureOwned(machine.name);
    try {
      await this.boxd.machines.delete(machine.id);
    } catch (err) {
      if (err instanceof NotFoundError) return;
      throw new AdapterTransportError(`release ${machineId}: ${String(err)}`);
    }
  }

  private async resolveMachineId(machineName: string): Promise<string> {
    const cached = this.machineIds.get(machineName);
    if (cached) return cached;
    try {
      const machine = await this.boxd.machines.get(machineName);
      this.machineIds.set(machineName, machine.id);
      return machine.id;
    } catch (err) {
      throw new AdapterTransportError(`machine ${machineName} unavailable: ${String(err)}`);
    }
  }

  /** Run one runner command and unwrap its `{ok}|{error}` envelope. */
  private async runner(machineId: string, args: string[], timeoutMs: number): Promise<unknown> {
    const result = await this.boxd.machines.exec(machineId, {
      command: ["sudo", "-n", RUNNER_BIN, ...args],
      timeout: timeoutMs,
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    const envelope = extractJson(result.stdout || combined) as RunnerEnvelope;
    if (envelope.error) {
      throw new RunnerCommandError(envelope.error.code ?? "unknown", envelope.error.message ?? combined);
    }
    if (!("ok" in envelope)) {
      throw new AdapterTransportError(`runner envelope missing ok/error: ${combined.slice(0, 400)}`);
    }
    return envelope.ok;
  }
}

/** The runner ran and reported a structured error (not a transport failure). */
export class RunnerCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunnerCommandError";
  }
}
