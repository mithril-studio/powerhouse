import { useEffect, useState } from "react";
import { useAppStore, type Repo } from "../store/appStore";
import { CloseIcon } from "./ui/icons";
import { cloudImportEnvFile, cloudProjectEnvStatus, cloudSetSecret } from "../lib/cloud";

const input = "ph-input h-8 font-mono";

/**
 * Per-repo env vars for cloud workspaces. Names live in the repo's config; values
 * go straight to the macOS Keychain (`project_env:<repo_id>:<NAME>`) and are
 * injected into that repo's runs only — never into snapshots or logs.
 */
export function RepoEnvEditor({ repo }: { repo: Repo }) {
  const setRepoEnvNames = useAppStore((s) => s.setRepoEnvNames);
  // The selected branch's worktree holds the `.env`; else the repo checkout.
  const importDir = useAppStore((s) =>
    s.selection.repoId === repo.id
      ? (repo.branches.find((b) => b.id === s.selection.branchId)?.worktreePath ?? repo.path)
      : repo.path,
  );
  const names = repo.cloudEnvNames ?? [];
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [nameInput, setNameInput] = useState("");
  const [valueInputs, setValueInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [envFile, setEnvFile] = useState(".env");
  const [importNote, setImportNote] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (names.length === 0) return;
    void cloudProjectEnvStatus(repo.id, names)
      .then((rows) => setStatus(Object.fromEntries(rows.map((r) => [r.name, r.set]))))
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.id, names.join(","), refresh]);

  const importFile = async () => {
    setError(null);
    setImportNote(null);
    try {
      const out = await cloudImportEnvFile(repo.id, importDir, envFile.trim() || ".env");
      const added = out.imported.filter((n) => !names.includes(n));
      if (added.length > 0) setRepoEnvNames(repo.id, [...names, ...added]);
      setRefresh((n) => n + 1);
      const parts = [`Imported ${out.imported.length}`];
      if (out.skipped.length > 0) parts.push(`skipped ${out.skipped.length} (${out.skipped.join(", ")})`);
      if (out.invalid > 0) parts.push(`${out.invalid} invalid line(s) ignored`);
      setImportNote(parts.join(" · "));
    } catch (e) {
      setError(String(e));
    }
  };

  const saveValue = async (name: string) => {
    const value = (valueInputs[name] ?? "").trim();
    setError(null);
    try {
      await cloudSetSecret(`project_env:${repo.id}:${name}`, value);
      setStatus((s) => ({ ...s, [name]: !!value }));
      setValueInputs((s) => ({ ...s, [name]: "" }));
    } catch (e) {
      setError(String(e));
    }
  };

  const addName = () => {
    const name = nameInput.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      setError(`\`${name}\` is not a valid environment variable name`);
      return;
    }
    if (!names.includes(name)) setRepoEnvNames(repo.id, [...names, name]);
    setNameInput("");
    setError(null);
  };

  const removeName = async (name: string) => {
    setRepoEnvNames(repo.id, names.filter((n) => n !== name));
    try {
      await cloudSetSecret(`project_env:${repo.id}:${name}`, "");
    } catch {
      // Nothing stored for the name is fine; the config entry is gone either way.
    }
  };

  return (
    <>
      {names.length > 0 && (
        <ul className="ph-list">
          {names.map((name) => {
            const typed = (valueInputs[name] ?? "").trim();
            return (
              <li key={name} className="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
                <span
                  className={`ph-dot ${status[name] ? "bg-current tone-running" : "ph-dot-ring text-muted-foreground/60"}`}
                  title={status[name] ? "Value stored" : "No value yet"}
                  aria-hidden
                />
                <span className="w-44 shrink-0 truncate font-mono text-xs" title={name}>
                  {name}
                </span>
                <input
                  type="password"
                  value={valueInputs[name] ?? ""}
                  onChange={(e) => setValueInputs((s) => ({ ...s, [name]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && typed && void saveValue(name)}
                  placeholder={status[name] ? "Stored. Paste to replace" : "Value"}
                  aria-label={`${name} value`}
                  spellCheck={false}
                  className={`${input} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  onClick={() => void saveValue(name)}
                  disabled={!typed && !status[name]}
                  className="ph-btn"
                >
                  {typed || !status[name] ? "Save" : "Clear"}
                </button>
                <button
                  type="button"
                  onClick={() => void removeName(name)}
                  title={`Remove ${name} and its stored value`}
                  aria-label={`Remove ${name}`}
                  className="ph-icon-btn shrink-0 hover:!text-destructive"
                >
                  <CloseIcon className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addName()}
          placeholder="VAR_NAME"
          aria-label="New variable name"
          spellCheck={false}
          className={`${input} w-56`}
        />
        <button type="button" onClick={addName} disabled={!nameInput.trim()} className="ph-btn">
          Add
        </button>
        <span className="flex-1" />
        <input
          value={envFile}
          onChange={(e) => setEnvFile(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void importFile()}
          placeholder=".env"
          spellCheck={false}
          aria-label="Env file to import"
          title={`Read from ${importDir}`}
          className={`${input} w-28`}
        />
        <button type="button" onClick={() => void importFile()} className="ph-btn" title={`Read from ${importDir}`}>
          Import
        </button>
      </div>
      <p className="ph-hint">
        {importNote ?? "Import stores every value from the file in your Keychain; importing again updates them."}
      </p>
      {error && <p className="ph-error">{error}</p>}
    </>
  );
}
