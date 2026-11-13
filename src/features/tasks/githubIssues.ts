import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
export interface BoardIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}
export interface IssuePage {
  repository: string;
  issues: BoardIssue[];
  next_page: number | null;
}
export interface IssueCache extends IssuePage {
  at: number;
  loading: boolean;
  error: string | null;
}
export const useIssueCache = create<{ repos: Record<string, IssueCache> }>(
  () => ({ repos: {} }),
);
const flights = new Set<string>();
export async function refreshIssues(
  repoId: string,
  repoPath: string,
  more = false,
) {
  if (flights.has(repoId)) return;
  flights.add(repoId);
  const prev = useIssueCache.getState().repos[repoId];
  const page = more ? prev?.next_page : 1;
  if (!page) {
    flights.delete(repoId);
    return;
  }
  const base: IssueCache = prev ?? {
    repository: "",
    issues: [],
    next_page: null,
    at: 0,
    loading: false,
    error: null,
  };
  const save = (data: IssueCache) =>
    useIssueCache.setState((s) => ({ repos: { ...s.repos, [repoId]: data } }));
  save({ ...base, loading: true, error: null });
  try {
    const result = await invoke<IssuePage>("github_board_issues", {
      repoPath,
      page,
    });
    const issues =
      more && base.repository === result.repository
        ? [
            ...new Map(
              [...base.issues, ...result.issues].map((i) => [i.number, i]),
            ).values(),
          ]
        : result.issues;
    save({ ...result, issues, at: Date.now(), loading: false, error: null });
  } catch (cause) {
    save({ ...base, loading: false, error: String(cause) });
  } finally {
    flights.delete(repoId);
  }
}
