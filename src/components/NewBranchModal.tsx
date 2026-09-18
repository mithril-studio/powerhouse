import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { createBranch } from "../lib/actions";

const ADJECTIVES = [
  "amber", "bold", "calm", "crisp", "deft", "eager", "fleet", "keen",
  "lucid", "nimble", "quiet", "rapid", "sharp", "solid", "swift", "vivid",
];
const NOUNS = [
  "aurora", "basalt", "comet", "delta", "ember", "falcon", "garnet", "harbor",
  "iris", "jasper", "krypton", "lagoon", "meadow", "nova", "onyx", "prism",
];

const suggestName = () =>
  `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]}-${
    NOUNS[Math.floor(Math.random() * NOUNS.length)]
  }`;

export function NewBranchModal() {
  const repoId = useAppStore((s) => s.branchModalRepoId);
  const repo = useAppStore((s) => s.repos.find((r) => r.id === s.branchModalRepoId) ?? null);
  const closeBranchModal = useAppStore((s) => s.closeBranchModal);

  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (repoId) {
      setName(suggestName());
      setError(null);
      setBusy(false);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [repoId]);

  if (!repoId || !repo) return null;

  const submit = async () => {
    const branchName = name.trim();
    if (!branchName || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createBranch(repoId, branchName);
      closeBranchModal();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-background/60 pt-32"
      onMouseDown={() => closeBranchModal()}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="pi-card w-96 p-4"
      >
        <p className="mb-1 font-medium">New branch</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Worktree off <span className="font-mono">{repo.defaultBranch}</span> in{" "}
          {repo.name}
        </p>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") closeBranchModal();
          }}
          disabled={busy}
          spellCheck={false}
          className="h-8 w-full rounded-lg border border-input bg-background px-2.5 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
        {error && (
          <p className="mt-2 max-h-24 select-text overflow-y-auto whitespace-pre-wrap font-mono text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={() => closeBranchModal()}
            className="h-8 rounded-lg px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
            className="pi-btn pi-btn-primary h-8 px-4 font-medium focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
