import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useAppStore } from "../../store/appStore";
import type { CloudRunRecord } from "../../lib/cloud";
import { importCloudResult } from "../../lib/actions";
import { createTask, updateTask } from "./taskStore";
import { TaskCloudDetails } from "./TaskCloudDetails";

const native = vi.hoisted(() => ({ import: vi.fn(), sync: vi.fn() }));
vi.mock("../../lib/cloud", async (original) => ({
  ...(await original<typeof import("../../lib/cloud")>()),
  cloudImport: native.import,
  cloudSync: native.sync,
}));
vi.mock("../../lib/terminalRegistry", () => ({
  disposeTerminal: vi.fn(),
  markAutoSpawn: vi.fn(),
}));
vi.mock("../../store/persist", () => ({ flushPersistence: vi.fn() }));
vi.mock("../../store/appStore", async (original) => {
  const actual = await original<typeof import("../../store/appStore")>();
  return {
    ...actual,
    useAppStore: Object.assign(
      (
        select: (s: ReturnType<typeof actual.useAppStore.getState>) => unknown,
      ) => select(actual.useAppStore.getState()),
      actual.useAppStore,
    ),
  };
});

function cloudRun(repoId: string, id: string): CloudRunRecord {
  return {
    run_id: id,
    repo_id: repoId,
    repo_path: "/repo",
    repo_name: "Repo",
    source_branch: "main",
    manifest: {
      task: { text: `Task ${id}`, acceptance_criteria: [] },
      source: {
        commit_sha: "abc",
        source_branch: "main",
        remote_url: "https://github.com/org/repo",
      },
      output_branch: `cloud/${id}`,
      checks: [],
      deadline_seconds: 600,
      agent: { provider: "claude", model: null, permission_mode: "dontAsk" },
    },
    manifest_digest: "digest",
    created_at_ms: 1,
    phase: "accepted",
    phase_detail: null,
    task_vm: null,
    receipt: { state: "completed", accepted_at_ms: 1, duplicate: false },
    snapshot: null,
    result: {
      run_id: id,
      source_sha: "abc",
      result_sha: "def",
      output_branch: `cloud/${id}`,
      published: true,
      publish_error: null,
      summary: "Done",
      concerns: [],
      checks_configured: false,
      checks: [],
      tree_changed_after_checks: false,
      changed_files: [],
      diff_bytes: 0,
      diff_truncated: false,
      provider_session_id: null,
      usage: null,
      agent_exit_code: 0,
      partial_work_preserved: true,
    },
    events: [],
    event_cursor: 0,
    last_sync_ms: 1,
    last_sync_error: null,
    imported_worktree: null,
    machine: "released",
    machine_changed_ms: 1,
    park_snapshot: null,
    vm_released: true,
    diff_cached: null,
    remote_verified: true,
    machine_error: null,
  };
}
function seed() {
  const repo = useAppStore
    .getState()
    .addRepo({ name: "Repo", path: "/repo", defaultBranch: "main" });
  const task = createTask({
    repoId: repo.id,
    title: "First task",
    description: "",
    agentId: "claude",
  });
  updateTask(task.id, { cloudRunId: "A" });
  const a = cloudRun(repo.id, "A");
  useAppStore.getState().setCloudRun(a);
  useAppStore.getState().setCloudRun(cloudRun(repo.id, "B"));
  native.import.mockResolvedValue({
    branch: "cloud/A",
    worktree_path: "/import/A",
  });
  native.sync.mockResolvedValue({ ...a, imported_worktree: "/import/A" });
  return useAppStore.getState().tasks[0];
}
beforeEach(() => {
  useAppStore.getState().hydrate(null);
  native.import.mockReset();
  native.sync.mockReset();
});

it("shows only the selected task's cloud run with its task-aware import", async () => {
  const task = seed();
  const html = renderToStaticMarkup(<TaskCloudDetails task={task} />);
  expect(html).toContain("Task A");
  expect(html).not.toContain("Task B");
  expect(html).not.toContain("Send to cloud");
  const card = TaskCloudDetails({ task });
  await card.props.onImport();
  expect(native.import).toHaveBeenCalledExactlyOnceWith("A");
  const branch = useAppStore.getState().repos[0].branches[0];
  expect(useAppStore.getState().tasks[0]).toMatchObject({
    branchId: branch.id,
    primaryChatId: null,
    turn: { outcome: "completed" },
  });
  expect(useAppStore.getState().cloudRuns.B.imported_worktree).toBeNull();
});

it("project-level imports also attach tasks and repeated imports preserve local work", async () => {
  const task = seed();
  await importCloudResult("A");
  const branch = useAppStore.getState().repos[0].branches[0];
  useAppStore
    .getState()
    .addChat(task.repoId, branch.id, { id: "local", title: "Continue" });
  updateTask(task.id, {
    primaryChatId: "local",
    turn: { outcome: "running", at: 123 },
  });
  await importCloudResult("A");
  expect(useAppStore.getState().repos[0].branches).toHaveLength(1);
  expect(useAppStore.getState().tasks[0]).toMatchObject({
    branchId: branch.id,
    primaryChatId: "local",
    turn: { outcome: "running", at: 123 },
  });
});
