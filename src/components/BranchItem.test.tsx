import { beforeEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useAppStore, type Branch, type Repo } from "../store/appStore";
import { BranchItem } from "./BranchItem";

beforeEach(() => {
  useAppStore.getState().hydrate(null);
});

function repoWithBranch(): { repo: Repo; branch: Branch } {
  const repo = useAppStore.getState().addRepo({
    name: "powerhouse",
    path: "/repo",
    defaultBranch: "main",
  });
  const branch: Branch = {
    id: "branch-1",
    name: "feature",
    worktreePath: "/repo-feature",
    chats: [],
    activeChatId: null,
  };
  useAppStore.getState().addBranch(repo.id, branch);
  return { repo: useAppStore.getState().repos[0], branch };
}

it("does not render a left-menu send-to-cloud button for branches", () => {
  const { repo, branch } = repoWithBranch();

  const html = renderToStaticMarkup(<BranchItem repo={repo} branch={branch} />);

  expect(html).not.toContain("Send feature to cloud");
  expect(html).toContain("Enqueue feature");
});
