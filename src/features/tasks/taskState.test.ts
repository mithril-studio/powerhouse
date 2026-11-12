import { beforeEach, expect, it } from "vitest";
import { useAppStore, type Branch } from "../../store/appStore";
import { adoptBranch, createTask, recordTaskTurn } from "./taskStore";
import { hydrateTasks, taskPresentation } from "./taskState";
import type { SessionActivity } from "./types";
const branch: Branch = { id: "b", name: "feature", worktreePath: "/b", chats: [{ id: "a", title: "A" }, { id: "b", title: "B" }], activeChatId: "a" };
const idle: SessionActivity = { connection: "ready", busy: false, permissionCount: 0, error: null };
beforeEach(() => { useAppStore.getState().hydrate(null); });
function seed() {
 const repo = useAppStore.getState().addRepo({ name: "r", path: "/r", defaultBranch: "main" });
 useAppStore.getState().addBranch(repo.id, branch);
 return adoptBranch(repo.id, branch.id);
}
it("adopts a branch once without changing its chats and worktree", () => {
 const t = seed(); expect(adoptBranch(t.repoId, "b").id).toBe(t.id);
 expect(useAppStore.getState().tasks).toHaveLength(1);
 expect(useAppStore.getState().repos[0].branches[0]).toEqual(branch);
});
it("permission in one chat outranks work and completion in another", () => {
 const t = { ...seed(), completion: { kind: "manual" as const, at: Date.now() } };
 expect(taskPresentation(t, branch, { a: { ...idle, permissionCount: 1 }, b: { ...idle, busy: true } }, []).column).toBe("attention");
 expect(taskPresentation(t, branch, { a: idle, b: { ...idle, busy: true } }, []).column).toBe("running");
});
it("new work reopens a completed task; hydration interrupts it", () => {
 const t = seed(); useAppStore.setState({ tasks: [{ ...t, completion: { kind: "manual", at: 1 } }] });
 recordTaskTurn("a", "running"); const next = useAppStore.getState().tasks[0];
 expect(next.completion).toBeUndefined(); expect(hydrateTasks([next])[0].turn?.outcome).toBe("interrupted");
});
it("deduplicates issue intake and restores the same task", () => {
 const t = seed(); const input = { repoId: t.repoId, title: "Issue", description: "Body", agentId: "claude", source: { repository: "Org/Repo", number: 3, url: "https://github.com/Org/Repo/issues/3" } };
 expect(createTask(input).id).toBe(createTask({ ...input, source: { ...input.source, repository: "org/repo" } }).id);
});
it("backlog creates no workspace, and removal archives an attached task", () => {
 const t = seed(); const draft = createTask({ repoId: t.repoId, title: "Later", description: "", agentId: "claude" });
 expect(draft.branchId).toBeNull(); expect(taskPresentation(draft, undefined, {}, []).column).toBe("backlog");
 useAppStore.getState().removeBranch(t.repoId, "b");
 expect(useAppStore.getState().tasks[0]).toMatchObject({ branchId: null, primaryChatId: null });
 expect(useAppStore.getState().tasks[0].archivedAt).not.toBeNull();
});
