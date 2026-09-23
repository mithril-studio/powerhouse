import type { GithubRepoSummary } from "./ipc";

export const MAX_SUGGESTIONS = 50;

/** Repos whose `owner/name` contains the query (case-insensitive), capped for
 *  the dropdown. An empty query lists the newest repos as returned by GitHub. */
export function filterRepos(
  repos: GithubRepoSummary[] | null,
  query: string,
  max = MAX_SUGGESTIONS,
): GithubRepoSummary[] {
  if (!repos) return [];
  const q = query.trim().toLowerCase();
  const matches = q ? repos.filter((r) => r.full_name.toLowerCase().includes(q)) : repos;
  return matches.slice(0, max);
}

/** What to hand to `git clone` for the input's text: a bare `owner/name` that
 *  matches a listed repo resolves to that repo's https URL; anything else is
 *  treated as a URL the user pasted. Returns null for empty input. */
export function resolveCloneUrl(repos: GithubRepoSummary[] | null, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const picked = repos?.find((r) => r.full_name.toLowerCase() === v.toLowerCase());
  return picked ? picked.clone_url : v;
}
