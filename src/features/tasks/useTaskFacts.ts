import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Repo } from "../../store/appStore";
import type { Task, TaskFacts } from "./types";
export function useTaskFacts(tasks: Task[], repos: Repo[]) {
  const [facts, setFacts] = useState<Record<string, TaskFacts>>({});
  const targets = tasks
    .filter((t) => !t.archivedAt && t.branchId)
    .flatMap((t) => {
      const repo = repos.find((r) => r.id === t.repoId);
      const branch = repo?.branches.find((b) => b.id === t.branchId);
      return branch && repo
        ? [{ id: t.id, path: branch.worktreePath, base: repo.defaultBranch }]
        : [];
    });
  const key = JSON.stringify(targets);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    const targets: { id: string; path: string; base: string }[] =
      JSON.parse(key);
    async function refresh() {
      if (busy || document.hidden) return;
      busy = true;
      // Bounded batches avoid firing one Git subprocess per card simultaneously.
      const next: Record<string, TaskFacts> = {};
      for (let i = 0; i < targets.length && !stopped; i += 4) {
        await Promise.all(
          targets.slice(i, i + 4).map(async (t) => {
            try {
              next[t.id] = await invoke<TaskFacts>("git_task_facts", {
                worktreePath: t.path,
                base: t.base,
              });
            } catch {
              /* No invented clean status for an unavailable workspace. */
            }
          }),
        );
      }
      if (!stopped) setFacts(next);
      busy = false;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    window.addEventListener("focus", refresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [key]);
  return facts;
}
