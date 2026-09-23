import { useEffect, useRef, useState } from "react";
import { cloneGithubProject, quickStartProject } from "../lib/actions";

export type AddProjectMode = "github" | "quickstart";

const COPY: Record<AddProjectMode, { title: string; label: string; placeholder: string; cta: string; hint: string }> = {
  github: {
    title: "Open GitHub project",
    label: "Repository URL",
    placeholder: "https://github.com/owner/repo",
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
 *  URL and creating a fresh project. Errors are shown inline (git's own text). */
export function AddProjectModal({ mode, onClose }: { mode: AddProjectMode; onClose: () => void }) {
  const copy = COPY[mode];
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "github") await cloneGithubProject(v);
      else await quickStartProject(v);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[28rem] max-w-[90vw] rounded-lg border border-border bg-background p-4 shadow-xl"
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
        <p className="mt-1 text-[11px] text-muted-foreground">{copy.hint}</p>
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
