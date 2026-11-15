import { useEffect, useRef, useState } from "react";
import { useAppStore, type BranchLocation } from "../store/appStore";
import { createBranch } from "../lib/actions";
import { gitListBranches, gitSweepBranches } from "../lib/ipc";
import { Dialog, Kbd } from "./ui/dialog";
import { ChevronDownIcon } from "./ui/icons";
import { Segmented } from "./ui/page";

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
  const [base, setBase] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Cloud by default: the agent runs on the branch's own VM. */
  const [location, setLocation] = useState<BranchLocation>("cloud");

  useEffect(() => {
    if (repoId) {
      setName(suggestName());
      setBase(repo?.defaultBranch ?? "");
      setBranches([]);
      setError(null);
      setBusy(false);
      setLocation("cloud");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [repoId, repo?.defaultBranch]);

  // Load the repo's branches so the user can pick a base other than the default.
  useEffect(() => {
    if (!repoId || !repo) return;
    let cancelled = false;
    // Sweep stale branches first so landed work never shows up as a base.
    void gitSweepBranches(repo.path, repo.defaultBranch, false)
      .catch(() => {})
      .then(() => gitListBranches(repo.path))
      .then((list) => {
        if (!cancelled) setBranches(list);
      })
      .catch(() => {
        /* fall back to just the default branch */
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, repo?.path, repo?.defaultBranch]);

  if (!repoId || !repo) return null;

  // Always offer the default branch, even before the list loads.
  const baseOptions = branches.includes(repo.defaultBranch)
    ? branches
    : [repo.defaultBranch, ...branches];

  const submit = async () => {
    const branchName = name.trim();
    if (!branchName || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createBranch(repoId, branchName, base, location);
      closeBranchModal();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title="New branch" onClose={closeBranchModal} busy={busy}>
      <div className="ph-dialog-body">
        <Segmented
          label="Where the agent runs"
          value={location}
          onChange={setLocation}
          disabled={busy}
          options={[
            { value: "cloud", label: "Cloud" },
            { value: "local", label: "Local" },
          ]}
        />
        <p className="ph-dialog-note mb-4">
          {location === "cloud"
            ? `Runs on its own VM from ${repo.name}'s VM image, and keeps going while your Mac sleeps.`
            : `New worktree in ${repo.name}; the agent runs on this Mac.`}
        </p>
        <label className="ph-field">
          Branch name
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            disabled={busy}
            spellCheck={false}
            className="ph-input font-mono"
          />
        </label>
        <label className="ph-field">
          Base branch
          <span className="ph-select ph-select-block">
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              disabled={busy}
              className="font-mono"
            >
              {baseOptions.map((b) => (
                <option key={b} value={b}>
                  {b}
                  {b === repo.defaultBranch ? " (default)" : ""}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="size-3.5" />
          </span>
        </label>
        {error && <p className="ph-dialog-error font-mono">{error}</p>}
      </div>
      <footer className="ph-dialog-foot">
        <button type="button" onClick={() => closeBranchModal()} disabled={busy} className="ph-btn ph-btn-ghost">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !name.trim()}
          className="ph-btn ph-btn-primary"
        >
          {busy ? "Creating…" : "Create"}
          {!busy && <Kbd>↵</Kbd>}
        </button>
      </footer>
    </Dialog>
  );
}
