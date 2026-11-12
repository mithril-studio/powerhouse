import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../store/appStore";
import { newWorkflowDraft } from "./workflowDrafts";

beforeEach(() => {
  useAppStore.getState().hydrate(null);
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
