import { manifestDigest, type ScriptManifest } from "../manifest.js";
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

interface FakeMachine {
  id: string;
  name: string;
  released: boolean;
}

interface FakeJob {
  jobId: string;
  machineName: string;
  digest: string;
  manifest: ScriptManifest;
  state: JobState;
  /** Inspect calls remaining before a live job turns terminal. */
  pollsUntilDone: number;
  /** Inspect calls remaining (after terminal) before the unit reports inactive. */
  unitActivePolls: number;
  exitCode: number | null;
  cancelRequested: boolean;
}

export interface FakeAdapterOptions {
  /** Inspect calls before a job completes on its own. */
  pollsUntilDone?: number;
  /** Inspect calls a terminal job keeps its unit active, exercising the release gate. */
  unitActivePolls?: number;
}

/**
 * Deterministic in-memory execution backend for recovery tests.
 *
 * Script semantics: a command containing `exit 1` fails with that exit code;
 * anything else completes with exit 0 after `pollsUntilDone` inspects.
 *
 * Fault injection: `failNext(op)` performs the external action, then throws
 * a transport error — "the action succeeded, the response was lost".
 * `gate(op)` returns a promise that resolves when the operation is entered,
 * and stalls it until `release()` — used to park a workflow at an exact
 * point so the test can kill the coordinator there.
 */
export class FakeExecutionAdapter implements ExecutionAdapter {
  readonly machines = new Map<string, FakeMachine>();
  readonly jobs = new Map<string, FakeJob>();

  /** External side effects actually performed, for duplicate-detection asserts. */
  machinesCreated = 0;
  jobsExecuted = 0;
  /** Ordered log of externally visible actions, for cleanup-ordering asserts. */
  readonly actions: string[] = [];

  private nextMachineSeq = 1;
  private readonly lostResponses = new Set<"ensureMachine" | "submitJob">();
  private gates = new Map<string, { entered: () => void; barrier: Promise<void> }>();

  constructor(private readonly options: FakeAdapterOptions = {}) {}

  /** Make the next call of `op` perform its action but lose the response. */
  failNext(op: "ensureMachine" | "submitJob"): void {
    this.lostResponses.add(op);
  }

  /**
   * Stall the next call of `op` after its side effect until `release` is
   * called. Resolves `entered` when the operation reaches that point.
   */
  gate(op: "ensureMachine" | "submitJob"): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const barrier = new Promise<void>((r) => (release = r));
    this.gates.set(op, { entered, barrier });
    return { entered: enteredPromise, release };
  }

  private async passGate(op: string): Promise<void> {
    const gate = this.gates.get(op);
    if (!gate) return;
    this.gates.delete(op);
    gate.entered();
    await gate.barrier;
  }

  private loseResponse(op: "ensureMachine" | "submitJob"): void {
    if (this.lostResponses.delete(op)) {
      throw new AdapterTransportError(`${op}: response lost after the action succeeded`);
    }
  }

  async ensureMachine(input: MachineRequest): Promise<MachineReceipt> {
    // Reconcile by name first: recovery must adopt, not duplicate.
    const existing = this.machines.get(input.name);
    if (existing && !existing.released) {
      return { machineId: existing.id, name: existing.name, created: false };
    }
    const machine: FakeMachine = {
      id: `fake-m-${this.nextMachineSeq++}`,
      name: input.name,
      released: false,
    };
    this.machines.set(input.name, machine);
    this.machinesCreated += 1;
    this.actions.push(`machine.create:${input.name}`);
    await this.passGate("ensureMachine");
    this.loseResponse("ensureMachine");
    return { machineId: machine.id, name: machine.name, created: true };
  }

  async submitJob(input: JobRequest): Promise<JobReceipt> {
    const digest = manifestDigest(input.manifest);
    const existing = this.jobs.get(input.jobId);
    if (existing) {
      if (existing.digest !== digest) {
        throw new ManifestConflictError(
          `job ${input.jobId} already exists with different manifest content`,
        );
      }
      return { jobId: input.jobId, manifestDigest: digest, state: existing.state, duplicate: true };
    }
    const failing = /(^|[^0-9])exit 1([^0-9]|$)/.test(input.manifest.script.command);
    const job: FakeJob = {
      jobId: input.jobId,
      machineName: input.machineName,
      digest,
      manifest: input.manifest,
      state: "running",
      pollsUntilDone: this.options.pollsUntilDone ?? 1,
      unitActivePolls: this.options.unitActivePolls ?? 1,
      exitCode: failing ? 1 : 0,
      cancelRequested: false,
    };
    this.jobs.set(input.jobId, job);
    this.jobsExecuted += 1;
    this.actions.push(`job.execute:${input.jobId}`);
    await this.passGate("submitJob");
    this.loseResponse("submitJob");
    return { jobId: input.jobId, manifestDigest: digest, state: job.state, duplicate: false };
  }

  async inspectJob(jobId: string): Promise<JobSnapshot> {
    const job = this.jobs.get(jobId);
    if (!job) throw new AdapterTransportError(`inspect: unknown job ${jobId}`);
    if (job.state === "running") {
      if (job.cancelRequested) {
        job.state = "cancelled";
        job.exitCode = null;
      } else if (job.pollsUntilDone <= 0) {
        job.state = job.exitCode === 0 ? "completed" : "failed";
      } else {
        job.pollsUntilDone -= 1;
      }
    }
    let unitActive = false;
    if (job.state === "running") {
      unitActive = true;
    } else if (job.unitActivePolls > 0) {
      // Terminal row precedes unit cleanup, like the real runner.
      job.unitActivePolls -= 1;
      unitActive = true;
    }
    return {
      jobId,
      state: job.state,
      unitActive,
      exitCode: job.state === "completed" || job.state === "failed" ? job.exitCode : null,
      outputTail: job.state === "completed" ? "fake output\n" : "",
      error: job.state === "failed" ? `script exited with code ${job.exitCode}` : null,
    };
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (!job.cancelRequested && !isTerminal(job.state)) {
      this.actions.push(`job.cancel:${jobId}`);
    }
    job.cancelRequested = true;
  }

  async releaseMachine(machineId: string): Promise<void> {
    for (const machine of this.machines.values()) {
      if (machine.id === machineId && !machine.released) {
        // Releasing a VM whose job process is still alive is the bug the
        // release gate exists to prevent; make it loud in tests.
        for (const job of this.jobs.values()) {
          if (job.machineName === machine.name && (job.state === "running" || job.unitActivePolls > 0)) {
            throw new Error(
              `released machine ${machine.name} while job ${job.jobId} still has an active process`,
            );
          }
        }
        machine.released = true;
        this.actions.push(`machine.release:${machine.name}`);
      }
    }
  }

  /** Convenience for tests: the machine name a job runs on. */
  machineName(jobId: string): string {
    return machineNameForJob(jobId);
  }
}

function isTerminal(state: JobState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "interrupted";
}
