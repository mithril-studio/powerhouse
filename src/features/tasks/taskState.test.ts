import { beforeEach, expect, it } from "vitest";
import { useAppStore, type Branch } from "../../store/appStore";
import { adoptBranch, createTask, recordTaskTurn } from "./taskStore";
import { hydrateTasks, taskPresentation } from "./taskState";
import type { SessionActivity } from "./types";
const branch: Branch = {
  id: "b",
  name: "feature",
  worktreePath: "/b",
  chats: [
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ],
  activeChatId: "a",
};
const idle: SessionActivity = {
  connection: "ready",
  busy: false,
  permissionCount: 0,
  error: null,
};
beforeEach(() => {
  useAppStore.getState().hydrate(null);
});
function seed() {
  const repo = useAppStore
    .getState()
    .addRepo({ name: "r", path: "/r", defaultBranch: "main" });
  useAppStore.getState().addBranch(repo.id, branch);
  return adoptBranch(repo.id, branch.id);
}
it("adopts a branch once without changing its chats and worktree", () => {
  const t = seed();
  expect(adoptBranch(t.repoId, "b").id).toBe(t.id);
  expect(useAppStore.getState().tasks).toHaveLength(1);
  expect(useAppStore.getState().repos[0].branches[0]).toEqual(branch);
});
it("permission in one chat outranks work and completion in another", () => {
  const t = {
    ...seed(),
    completion: { kind: "manual" as const, at: Date.now() },
  };
  expect(
    taskPresentation(
      t,
      branch,
      { a: { ...idle, permissionCount: 1 }, b: { ...idle, busy: true } },
      [],
    ).column,
  ).toBe("attention");
  expect(
    taskPresentation(t, branch, { a: idle, b: { ...idle, busy: true } }, [])
      .column,
  ).toBe("running");
});
it("new work reopens a completed task; hydration interrupts it", () => {
  const t = seed();
  useAppStore.setState({
    tasks: [{ ...t, completion: { kind: "manual", at: 1 } }],
  });
  recordTaskTurn("a", "running");
  const next = useAppStore.getState().tasks[0];
  expect(next.completion).toBeUndefined();
  expect(hydrateTasks([next])[0].turn?.outcome).toBe("interrupted");
});
it("deduplicates issue intake and restores the same task", () => {
  const t = seed();
  const input = {
    repoId: t.repoId,
    title: "Issue",
    description: "Body",
    agentId: "claude",
    source: {
      repository: "Org/Repo",
      number: 3,
      url: "https://github.com/Org/Repo/issues/3",
    },
  };
  expect(createTask(input).id).toBe(
    createTask({
      ...input,
      source: { ...input.source, repository: "org/repo" },
    }).id,
  );
});
it("backlog creates no workspace, and removal archives an attached task", () => {
  const t = seed();
  const draft = createTask({
    repoId: t.repoId,
    title: "Later",
    description: "",
    agentId: "claude",
  });
  expect(draft.branchId).toBeNull();
  expect(taskPresentation(draft, undefined, {}, []).column).toBe("backlog");
  useAppStore.getState().removeBranch(t.repoId, "b");
  expect(useAppStore.getState().tasks[0]).toMatchObject({
    branchId: null,
    primaryChatId: null,
  });
  expect(useAppStore.getState().tasks[0].archivedAt).not.toBeNull();
});
it("completed merge returns to review when the working copy advances", () => {
  const t = {
    ...seed(),
    completion: {
      kind: "merged" as const,
      at: 10,
      commit: "merge",
      sourceSha: "tested",
    },
  };
  expect(
    taskPresentation(t, branch, {}, [], {
      head: "tested",
      dirty: false,
      changed_files: 1,
    }).column,
  ).toBe("done");
  expect(
    taskPresentation(t, branch, {}, [], {
      head: "new",
      dirty: false,
      changed_files: 2,
    }).column,
  ).toBe("review");
  expect(
    taskPresentation(t, branch, {}, [], {
      head: "tested",
      dirty: true,
      changed_files: 1,
    }).column,
  ).toBe("review");
});
it("a failed sibling session survives a later completed turn and restart", () => {
  seed();
  recordTaskTurn("a", "failed", "lost connection");
  recordTaskTurn("b", "completed");
  const s = useAppStore.getState();
  const b = s.repos[0].branches[0];
  expect(taskPresentation(s.tasks[0], b, {}, []).column).toBe("attention");
});
it("merge completion survives queue-history eviction", () => {
  const t = seed();
  useAppStore
    .getState()
    .setQueueEntries(t.repoId, [
      {
        id: "q",
        repo_id: t.repoId,
        branch: "feature",
        state: "merged",
        steps: [],
        error: null,
        merge_commit: "merge",
        source_sha: "source",
        created_at: 1,
        finished_at: 2,
      },
    ]);
  const task = useAppStore.getState().tasks[0];
  expect(task.completion).toMatchObject({
    kind: "merged",
    commit: "merge",
    sourceSha: "source",
  });
  expect(taskPresentation(task, branch, {}, []).column).toBe("done");
});

it("removing a project removes its tasks, which could no longer be opened or archived", () => {
  const t = seed();
  expect(useAppStore.getState().tasks.some((x) => x.id === t.id)).toBe(true);
  useAppStore.getState().removeRepo(t.repoId);
  expect(useAppStore.getState().tasks.some((x) => x.repoId === t.repoId)).toBe(false);
});
