import { describe, expect, it } from "vitest";
import { buildQuickSubmitRequest } from "./quickSubmit";
import { DEFAULT_CLOUD_SETTINGS, useAppStore, type Repo, type Settings } from "../store/appStore";

const repo: Repo = {
  id: "r1",
  name: "app",
  path: "/repos/app",
  defaultBranch: "main",
  branches: [],
  workflow: [
    { id: "w1", name: "tests", command: "npm test", type: "command" },
    { id: "w2", name: "empty", command: "   ", type: "command" },
  ],
  pushOnMerge: false,
};

const settings = {
  cloud: {
    ...DEFAULT_CLOUD_SETTINGS,
    baseSnapshot: " powerhouse-base ",
    allowedTools: "Read, Edit,,Bash ",
    deadlineMinutes: 45.4,
    model: "  ",
  },
} as Settings;

describe("buildQuickSubmitRequest", () => {
  it("carries the last-used settings and the repo workflow as checks", () => {
    const req = buildQuickSubmitRequest(repo, "/repos/app/.wt/feat", settings);
    expect(req.repoId).toBe("r1");
    expect(req.sourcePath).toBe("/repos/app/.wt/feat");
    expect(req.baseSnapshot).toBe("powerhouse-base");
    expect(req.checks).toEqual([{ name: "tests", command: "npm test" }]);
    expect(req.deadlineSeconds).toBe(45 * 60);
    expect(req.allowedTools).toEqual(["Read", "Edit", "Bash"]);
    expect(req.model).toBeNull();
    expect(req.provider).toBe("claude");
    expect(req.envNames).toEqual([]);
  });

  it("passes the repo's configured env names", () => {
    const req = buildQuickSubmitRequest({ ...repo, cloudEnvNames: ["FOO_API_KEY"] }, repo.path, settings);
    expect(req.envNames).toEqual(["FOO_API_KEY"]);
  });

  it("falls back to defaults when no cloud settings were ever saved", () => {
    const req = buildQuickSubmitRequest(repo, repo.path, { cloud: undefined } as Settings);
    expect(req.baseSnapshot).toBe(DEFAULT_CLOUD_SETTINGS.baseSnapshot);
    expect(req.machineCeiling).toBe(DEFAULT_CLOUD_SETTINGS.machineCeiling);
  });
});

describe("cloud quick stage mirror", () => {
  it("tracks and clears per-branch stages without leaking keys", () => {
    const s = () => useAppStore.getState();
    s().setCloudQuickStage("r1", "feat/x", "checkpointing");
    expect(s().cloudQuickStages["r1:feat/x"]).toBe("checkpointing");
    s().setCloudQuickStage("r1", "feat/x", "pushing");
    expect(s().cloudQuickStages["r1:feat/x"]).toBe("pushing");
    s().setCloudQuickStage("r1", "feat/x", null);
    expect(s().cloudQuickStages).toEqual({});
    // Clearing an unknown key is a no-op, not an error.
    s().setCloudQuickStage("r1", "never-started", null);
    expect(s().cloudQuickStages).toEqual({});
  });
});
