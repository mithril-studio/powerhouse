import { beforeEach, expect, it, vi } from "vitest";
import { refreshIssues, useIssueCache } from "./githubIssues";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => {
  useIssueCache.setState({ repos: {} });
  invoke.mockReset();
});
const issue = {
  number: 7,
  title: "Build it",
  body: "Details",
  url: "https://github.com/o/r/issues/7",
  labels: [],
};
it("deduplicates pages and retains visible stale data after a network error", async () => {
  invoke.mockResolvedValueOnce({
    repository: "o/r",
    issues: [issue],
    next_page: 2,
  });
  await refreshIssues("r", "/r");
  invoke.mockResolvedValueOnce({
    repository: "o/r",
    issues: [issue, { ...issue, number: 8 }],
    next_page: null,
  });
  await refreshIssues("r", "/r", true);
  expect(useIssueCache.getState().repos.r.issues).toHaveLength(2);
  expect(invoke).toHaveBeenLastCalledWith("github_board_issues", {
    repoPath: "/r",
    page: 2,
  });
  invoke.mockRejectedValueOnce(new Error("offline"));
  await refreshIssues("r", "/r");
  expect(useIssueCache.getState().repos.r.issues).toHaveLength(2);
  expect(useIssueCache.getState().repos.r.error).toContain("offline");
});
