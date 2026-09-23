import { describe, expect, it } from "vitest";
import { filterRepos, resolveCloneUrl } from "./addProject";
import type { GithubRepoSummary } from "./ipc";

const repo = (full_name: string, priv = false): GithubRepoSummary => ({
  full_name,
  clone_url: `https://github.com/${full_name}.git`,
  private: priv,
});

const REPOS = [repo("acme/powerhouse"), repo("acme/site", true), repo("joost/notes")];

describe("filterRepos", () => {
  it("returns nothing before the list has loaded", () => {
    expect(filterRepos(null, "acme")).toEqual([]);
  });

  it("lists everything (up to the cap) for an empty query", () => {
    expect(filterRepos(REPOS, "  ")).toEqual(REPOS);
    expect(filterRepos(REPOS, "", 2)).toEqual(REPOS.slice(0, 2));
  });

  it("matches case-insensitively on any part of owner/name", () => {
    expect(filterRepos(REPOS, "ACME").map((r) => r.full_name)).toEqual(["acme/powerhouse", "acme/site"]);
    expect(filterRepos(REPOS, "note").map((r) => r.full_name)).toEqual(["joost/notes"]);
    expect(filterRepos(REPOS, "nope")).toEqual([]);
  });
});

describe("resolveCloneUrl", () => {
  it("is null for empty input", () => {
    expect(resolveCloneUrl(REPOS, "")).toBeNull();
    expect(resolveCloneUrl(REPOS, "   ")).toBeNull();
  });

  it("resolves a picked owner/name to its https clone URL, ignoring case", () => {
    expect(resolveCloneUrl(REPOS, "acme/site")).toBe("https://github.com/acme/site.git");
    expect(resolveCloneUrl(REPOS, " Acme/Site ")).toBe("https://github.com/acme/site.git");
  });

  it("passes anything else through as a pasted URL", () => {
    expect(resolveCloneUrl(REPOS, "git@github.com:other/thing.git")).toBe("git@github.com:other/thing.git");
    expect(resolveCloneUrl(null, "https://github.com/x/y")).toBe("https://github.com/x/y");
  });
});
