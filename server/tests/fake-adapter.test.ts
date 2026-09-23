import { describe, expect, it } from "vitest";

import { FakeExecutionAdapter } from "../src/adapters/fake.js";
import { ManifestConflictError, machineNameForJob } from "../src/adapters/types.js";
import { buildScriptManifest } from "../src/manifest.js";

const JOB_ID = "0f4a2c6e-6a2b-4c4e-9f3a-1b2c3d4e5f60";

function manifest(command = "printf ok") {
  return buildScriptManifest({
    runId: JOB_ID,
    taskText: "t",
    repoName: "r",
    remoteUrl: "https://example.com/r.git",
    commitSha: "a".repeat(40),
    snapshotName: "base",
    snapshotVersion: "v1",
    command,
    deadlineSeconds: 300,
    createdAtMs: 7,
  });
}

describe("FakeExecutionAdapter runner contract", () => {
  it("same job UUID and manifest produce one execution and a duplicate receipt", async () => {
    const fake = new FakeExecutionAdapter();
    await fake.ensureMachine({ name: machineNameForJob(JOB_ID), snapshotName: "base", snapshotVersion: "v1" });
    const first = await fake.submitJob({ jobId: JOB_ID, machineName: machineNameForJob(JOB_ID), manifest: manifest() });
    const second = await fake.submitJob({ jobId: JOB_ID, machineName: machineNameForJob(JOB_ID), manifest: manifest() });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(fake.jobsExecuted).toBe(1);
  });

  it("same job UUID with changed manifest content is rejected", async () => {
    const fake = new FakeExecutionAdapter();
    await fake.submitJob({ jobId: JOB_ID, machineName: machineNameForJob(JOB_ID), manifest: manifest("printf a") });
    await expect(
      fake.submitJob({ jobId: JOB_ID, machineName: machineNameForJob(JOB_ID), manifest: manifest("printf b") }),
    ).rejects.toBeInstanceOf(ManifestConflictError);
    expect(fake.jobsExecuted).toBe(1);
  });

  it("machine creation reconciles by name after a lost response", async () => {
    const fake = new FakeExecutionAdapter();
    fake.failNext("ensureMachine");
    const req = { name: "ph-wf-test1", snapshotName: "base", snapshotVersion: null };
    await expect(fake.ensureMachine(req)).rejects.toThrow(/response lost/);
    const recovered = await fake.ensureMachine(req);
    expect(recovered.created).toBe(false);
    expect(fake.machinesCreated).toBe(1);
  });

  it("job submission reconciles to a duplicate receipt after a lost response", async () => {
    const fake = new FakeExecutionAdapter();
    fake.failNext("submitJob");
    const req = { jobId: JOB_ID, machineName: machineNameForJob(JOB_ID), manifest: manifest() };
    await expect(fake.submitJob(req)).rejects.toThrow(/response lost/);
    const recovered = await fake.submitJob(req);
    expect(recovered.duplicate).toBe(true);
    expect(fake.jobsExecuted).toBe(1);
  });
});
