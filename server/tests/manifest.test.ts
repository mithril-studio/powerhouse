import { describe, expect, it } from "vitest";

import { buildScriptManifest, manifestDigest } from "../src/manifest.js";

describe("manifest digest", () => {
  it("matches the Rust runner digest for the protocol fixture", () => {
    // cloud/protocol/tests/fixtures/script-v3.json, digested by
    // `powerhouse-runner digest` (cloud/protocol/src/lib.rs::digest).
    const manifest = buildScriptManifest({
      runId: "0f4a2c6e-6a2b-4c4e-9f3a-1b2c3d4e5f60",
      taskText: "Run repository tests",
      repoName: "powerhouse",
      remoteUrl: "https://github.com/mithril-studio/powerhouse.git",
      commitSha: "db2b7c51b4cb9f64816e15675f2453fdb86a977f",
      snapshotName: "powerhouse-base",
      snapshotVersion: "v1",
      command: "printf 'workflow output\\n'",
      deadlineSeconds: 900,
      createdAtMs: 1,
    });
    expect(manifestDigest(manifest)).toBe(
      "696da089872139167534a6f804ca072b79f0b91c42ba6d6cb725a2a1006d51cc",
    );
  });

  it("is stable across identical builds and sensitive to content", () => {
    const build = (command: string) =>
      buildScriptManifest({
        runId: "0f4a2c6e-6a2b-4c4e-9f3a-1b2c3d4e5f60",
        taskText: "t",
        repoName: "r",
        remoteUrl: "https://example.com/r.git",
        commitSha: "a".repeat(40),
        snapshotName: "base",
        snapshotVersion: null,
        command,
        deadlineSeconds: 300,
        createdAtMs: 42,
      });
    expect(manifestDigest(build("echo hi"))).toBe(manifestDigest(build("echo hi")));
    expect(manifestDigest(build("echo hi"))).not.toBe(manifestDigest(build("echo bye")));
  });
});
