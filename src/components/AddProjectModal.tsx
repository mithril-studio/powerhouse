import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cloneGithubProject, quickStartProject } from "../lib/actions";
import { githubListRepos, type GithubRepoSummary } from "../lib/ipc";
import { filterRepos, resolveCloneUrl } from "../lib/addProject";

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
 *  project. Errors are shown inline (git's own text).
 *
 *  Picking a repo from the list only fills the input and closes the list; the
 *  clone starts on Enter or the Clone button, so a failure is visible in the
 *  modal instead of hidden behind the suggestions. */
export function AddProjectModal({ mode, onClose }: { mode: AddProjectMode; onClose: () => void }) {
  const copy = COPY[mode];
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepoSummary[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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

  const suggestions = useMemo(
    () => (mode === "github" ? filterRepos(repos, value) : []),
    [mode, repos, value],
  );

  // Keep the highlighted row valid as the filter changes.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, suggestions.length - 1)));
  }, [suggestions.length]);

  // Keep the highlighted row scrolled into view for keyboard navigation.
  useEffect(() => {
    if (!showList) return;
    const row = listRef.current?.children[highlight] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [highlight, showList]);

  const listOpen = mode === "github" && showList && suggestions.length > 0;

  const pick = (r: GithubRepoSummary) => {
    setValue(r.full_name);
    setError(null);
    setShowList(false);
    inputRef.current?.focus();
  };

  const runClone = async (url: string) => {
    setBusy(true);
    setError(null);
    setShowList(false);
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
      const url = resolveCloneUrl(repos, v);
      if (url) await runClone(url);
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

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (listOpen) {
        e.preventDefault();
        setShowList(false);
      } else {
        onClose();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!listOpen) {
        setShowList(true);
        return;
      }
      setHighlight((h) => (h + 1) % suggestions.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (listOpen) setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (listOpen) {
        pick(suggestions[highlight]);
        return;
      }
      void submit();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[30rem] max-w-[90vw] rounded-lg border border-border bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => {
          // A click anywhere in the modal outside the input/list dismisses the list.
          const t = e.target as Node;
          if (inputRef.current?.contains(t) || listRef.current?.contains(t)) return;
          setShowList(false);
        }}
      >
        <h2 className="text-sm font-semibold text-foreground">{copy.title}</h2>
        <label className="mt-3 block text-xs font-medium text-muted-foreground">{copy.label}</label>
        <div className="relative">
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
              setHighlight(0);
              setShowList(true);
            }}
            onFocus={() => setShowList(true)}
            onKeyDown={onKeyDown}
            placeholder={copy.placeholder}
            disabled={busy}
            role={mode === "github" ? "combobox" : undefined}
            aria-expanded={mode === "github" ? listOpen : undefined}
            aria-autocomplete={mode === "github" ? "list" : undefined}
            className="mt-1 w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-accent-brand disabled:opacity-50"
          />
          {listOpen && (
            <ul
              ref={listRef}
              role="listbox"
              className="absolute left-0 right-0 z-10 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-background py-1 shadow-xl"
            >
              {suggestions.map((r, i) => (
                <li key={r.full_name} role="option" aria-selected={i === highlight}>
                  <button
                    type="button"
                    disabled={busy}
                    // mousedown (not click) so the pick lands before the input blurs
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(r);
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground disabled:opacity-50 ${
                      i === highlight ? "bg-muted" : ""
                    }`}
                  >
                    <span className="truncate">{r.full_name}</span>
                    {r.private && (
                      <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                        private
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
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
