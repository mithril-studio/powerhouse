import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../store/appStore";
import { newWorkflowDraft } from "./workflowDrafts";

beforeEach(() => {
  useAppStore.getState().hydrate(null);
  useAppStore.setState({ workspaceView: "home", settingsOpen: false, telemetryOpen: false });
});

describe("workflow navigation", () => {
  it("opens Workflows without changing the selected chat or closing sessions", () => {
    useAppStore.setState({ selection: { repoId: "repo", branchId: "branch" }, chatStatus: { chat: "running" }, telemetryOpen: true });
    useAppStore.getState().setWorkspaceView("workflows");
    expect(useAppStore.getState().workspaceView).toBe("workflows");
    expect(useAppStore.getState().selection).toEqual({ repoId: "repo", branchId: "branch" });
    expect(useAppStore.getState().chatStatus.chat).toBe("running");
    expect(useAppStore.getState().telemetryOpen).toBe(false);
  });

  it("returns to Home when a project or branch is selected", () => {
    useAppStore.getState().setWorkspaceView("workflows");
    useAppStore.getState().select("repo", "branch");
    expect(useAppStore.getState().workspaceView).toBe("home");
  });
});

describe("local workflow drafts", () => {
  it("starts old installations with no workflow drafts", () => {
    expect(useAppStore.getState().workflowDrafts).toEqual([]);
  });

  it("keeps draft edits through persisted-tree hydration, separately from merge checks", () => {
    const repo = useAppStore.getState().addRepo({ name: "repo", path: "/repo", defaultBranch: "main" });
    const draft = newWorkflowDraft(repo.id);
    useAppStore.getState().saveWorkflowDraft(draft);
    const edited = { ...draft, name: "Verify", steps: [{ ...draft.steps[0], command: "pnpm test" }] };
    useAppStore.getState().saveWorkflowDraft(edited);
    expect(useAppStore.getState().workflowDrafts).toEqual([edited]);
    const { repos, workflowDrafts } = useAppStore.getState();
    useAppStore.getState().hydrate({ repos, workflowDrafts });
    expect(useAppStore.getState().workflowDrafts).toEqual([edited]);
    expect(useAppStore.getState().repos[0].workflow).toEqual([]);
  });
});
