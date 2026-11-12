import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useAppStore } from "../../store/appStore";
import { WorkflowsPage } from "./WorkflowsPage";
import { newWorkflowDraft } from "./workflowDrafts";

vi.mock("../../store/appStore", async (original) => {
  const actual = await original<typeof import("../../store/appStore")>();
  return { ...actual, useAppStore: Object.assign(
    (select: (s: ReturnType<typeof actual.useAppStore.getState>) => unknown) => select(actual.useAppStore.getState()),
    actual.useAppStore,
  ) };
});
beforeEach(() => useAppStore.getState().hydrate(null));

it("offers project filtering, a blank start and an independent merge-check copy", () => {
  const repo = useAppStore.getState().addRepo({ name: "sample", path: "/sample", defaultBranch: "main" });
  useAppStore.getState().setWorkflow(repo.id, [{ id: "check", name: "test", command: "pnpm test", type: "command" }], false);
  const html = renderToStaticMarkup(<WorkflowsPage />);
  expect(html).toContain("Filter by project");
  expect(html).toContain("Create your first workflow");
  expect(html).toContain("Copy sample merge checks");
  expect(html).not.toContain("No runs.");
});

it("shows actionable draft errors and does not imply a valid draft is published or runnable", () => {
  const repo = useAppStore.getState().addRepo({ name: "sample", path: "/sample", defaultBranch: "main" });
  const draft = newWorkflowDraft(repo.id);
  useAppStore.getState().saveWorkflowDraft(draft);
  let html = renderToStaticMarkup(<WorkflowsPage />);
  expect(html).toContain("Add a command for this step.");
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain("Needs attention");
  expect(html).toContain("Duplicate");
  expect(html).toContain("Delete draft");
  useAppStore.getState().saveWorkflowDraft({ ...draft, steps: [{ ...draft.steps[0], command: "pnpm test" }] });
  html = renderToStaticMarkup(<WorkflowsPage />);
  expect(html).toContain("Draft checks passed");
  expect(html).toContain("Not published");
  expect(html).toContain("Execution not connected");
  expect(html).toContain('disabled="" aria-describedby="workflow-run-unavailable"');
});
