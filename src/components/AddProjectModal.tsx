import { useEffect, useMemo, useRef, useState } from "react";
import { cloneGithubProject, quickStartProject } from "../lib/actions";
import { githubListRepos, type GithubRepoSummary } from "../lib/ipc";

export type AddProjectMode = "github" | "quickstart";

const COPY: Record<AddProjectMode, { title: string; label: string; placeholder: string; cta: string; hint: string }> = {
  github: {
    title: "Open GitHub project",
    label: "Repository",
    placeholder: "Search your repositories or paste a URL",
    cta: "Clone",
    hint: "Cloned into ~/conductor/repos.",
  },
  quickstart: {
    title: "Quick start",
    label: "Project name",
    placeholder: "my-new-app",
    cta: "Create",
    hint: "Creates ~/conductor/repos/<name> with an initial commit.",
  },
};

/** Modal for the two Add-project flows that need text input: cloning a GitHub
 *  repo (with autocomplete over the signed-in account) and creating a fresh
 *  project. Errors are shown inline (git's own text). */
export function AddProjectModal({ mode, onClose }: { mode: AddProjectMode; onClose: () => void }) {
  const copy = COPY[mode];
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepoSummary[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Load the account's repositories for autocomplete (GitHub mode only).
  useEffect(() => {
    if (mode !== "github") return;
    let alive = true;
    githubListRepos()
      .then((r) => alive && setRepos(r))
      .catch((e) => alive && setReposError(String(e)));
    return () => {
      alive = false;
    };
  }, [mode]);

  const suggestions = useMemo(() => {
    if (mode !== "github" || !repos) return [];
    const q = value.trim().toLowerCase();
    const matches = q
      ? repos.filter((r) => r.full_name.toLowerCase().includes(q))
      : repos;
    return matches.slice(0, 50);
  }, [mode, repos, value]);

  const runClone = async (url: string) => {
    setBusy(true);
    setError(null);
    try {
      await cloneGithubProject(url);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const submit = async () => {
    const v = value.trim();
    if (!v || busy) return;
    if (mode === "github") {
      // A bare "owner/repo" from the list resolves to its https URL.
      const picked = repos?.find((r) => r.full_name.toLowerCase() === v.toLowerCase());
      await runClone(picked ? picked.clone_url : v);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await quickStartProject(v);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-[30rem] max-w-[90vw] rounded-lg border border-border bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-foreground">{copy.title}</h2>
        <label className="mt-3 block text-xs font-medium text-muted-foreground">{copy.label}</label>
        <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") onClose();
            }}
            placeholder={copy.placeholder}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-accent-brand disabled:opacity-50"
          />
        {/* In-flow (not a floating dropdown) so it never covers the buttons.
            Click selects; double-click clones straight away. */}
        {mode === "github" && !reposError && (
          <ul className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border py-1">
            {repos === null ? (
              <li className="px-2.5 py-1.5 text-xs text-muted-foreground">Loading repositories…</li>
            ) : suggestions.length === 0 ? (
              <li className="px-2.5 py-1.5 text-xs text-muted-foreground">No matching repositories.</li>
            ) : (
              suggestions.map((r) => {
                const selected = r.full_name.toLowerCase() === value.trim().toLowerCase();
                return (
                  <li key={r.full_name}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setValue(r.full_name)}
                      onDoubleClick={() => void runClone(r.clone_url)}
                      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-muted disabled:opacity-50 ${selected ? "bg-muted" : ""}`}
                    >
                      <span className="truncate">{r.full_name}</span>
                      {r.private && (
                        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          private
                        </span>
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          {mode === "github" && reposError ? reposError : copy.hint}
        </p>
        {error && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !value.trim()}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            {busy ? (mode === "github" ? "Cloning…" : "Creating…") : copy.cta}
          </button>
        </div>
      </div>
    </div>
  );
}
