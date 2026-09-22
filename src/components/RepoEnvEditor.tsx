import { useEffect, useState } from "react";
import { useAppStore, type Repo } from "../store/appStore";
import { cloudProjectEnvStatus, cloudSetSecret } from "../lib/cloud";

const input =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

/**
 * Per-repo env vars for cloud runs. Names live in the repo's config; values
 * go straight to the macOS Keychain (`project_env:<repo_id>:<NAME>`) and are
 * injected into that repo's runs only — never into snapshots or logs.
 */
export function RepoEnvEditor({ repo }: { repo: Repo }) {
  const setRepoEnvNames = useAppStore((s) => s.setRepoEnvNames);
  const names = repo.cloudEnvNames ?? [];
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [nameInput, setNameInput] = useState("");
  const [valueInputs, setValueInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (names.length === 0) return;
    void cloudProjectEnvStatus(repo.id, names)
      .then((rows) => setStatus(Object.fromEntries(rows.map((r) => [r.name, r.set]))))
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.id, names.join(",")]);

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
    <div className="space-y-1.5 text-xs">
      {names.map((name) => (
        <div key={name} className="flex items-center gap-1.5">
          <span className="w-40 shrink-0 truncate font-mono" title={name}>
            {status[name] ? "✓" : "∅"} {name}
          </span>
          <input
            type="password"
            value={valueInputs[name] ?? ""}
            onChange={(e) => setValueInputs((s) => ({ ...s, [name]: e.target.value }))}
            placeholder={status[name] ? "value stored — paste to replace" : "value (kept in your Keychain)"}
            spellCheck={false}
            className={`${input} font-mono`}
          />
          <button
            onClick={() => void saveValue(name)}
            disabled={!(valueInputs[name] ?? "").trim() && !status[name]}
            className="h-8 shrink-0 rounded-lg border border-border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {(valueInputs[name] ?? "").trim() ? "Save" : "Clear"}
          </button>
          <button
            onClick={() => void removeName(name)}
            title={`Remove ${name} and its stored value`}
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-destructive"
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <input
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addName()}
          placeholder="VAR_NAME"
          spellCheck={false}
          className={`${input} w-40 shrink-0 grow-0 font-mono`}
        />
        <button
          onClick={addName}
          disabled={!nameInput.trim()}
          className="h-8 shrink-0 rounded-lg border border-border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Add
        </button>
        <p className="min-w-0 flex-1 text-muted-foreground">
          Injected into this repo's cloud runs and <span className="font-mono">.env</span> on the VM only.
        </p>
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
