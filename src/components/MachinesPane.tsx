import { useCallback, useEffect, useState } from "react";
import { useAppStore, type Branch } from "../store/appStore";
import { runInShell } from "../lib/cloud";
import {
  canStart,
  isRunning,
  machineCreate,
  machineRemove,
  machineStart,
  machineStop,
  machineSuggestName,
  machinesList,
  machinesProblem,
  machinesSummary,
  statusTone,
  type MachineRow,
} from "../lib/machines";

const REFRESH_MS = 15_000;

const action =
  "h-6 shrink-0 rounded-md border border-border px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";

const DOT = {
  on: "bg-green-500",
  busy: "animate-pulse bg-amber-500",
  off: "bg-muted-foreground/40",
};

/** Every boxd machine on the account. Mounted only while the tab is open, so
 *  it polls only then. */
export function MachinesPane({ branch }: { branch: Branch | null }) {
  const [rows, setRows] = useState<MachineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [branchVm, setBranchVm] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await machinesList());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const branchName = branch?.name;
  useEffect(() => {
    setBranchVm(null);
    if (branchName) void machineSuggestName(branchName).then(setBranchVm).catch(() => {});
  }, [branchName]);

  /** Runs one row action, shows its label while it runs, then refreshes. */
  const run = async (vm: string, label: string, fn: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [vm]: label }));
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(({ [vm]: _, ...rest }) => rest);
      void refresh();
    }
  };

  const problem = machinesProblem(error);

  return (
    <div className="flex h-full flex-col overflow-y-auto px-3 py-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Machines</span>
        <span className="h-px flex-1 bg-border" />
        {rows && <span className="text-[11px] text-muted-foreground">{machinesSummary(rows)}</span>}
        <button
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh machines"
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground disabled:opacity-40"
        >
          ↻
        </button>
        <button
          onClick={() => setCreating(creating === null ? (branchVm ?? "ph-") : null)}
          disabled={problem !== null}
          className={action}
        >
          New
        </button>
      </div>

      {creating !== null && (
        <NewMachine
          initial={creating}
          onCancel={() => setCreating(null)}
          onCreate={async (name) => {
            await machineCreate(name);
            setCreating(null);
            void refresh();
          }}
        />
      )}

      {problem === "signed-out" ? (
        <Notice>
          boxd is signed out.{" "}
          {branch ? (
            <button onClick={() => runInShell(branch.id, "boxd auth login")} className="underline hover:text-foreground">
              Sign in
            </button>
          ) : (
            <>
              Run <code>boxd auth login</code>
            </>
          )}
          , then refresh.
        </Notice>
      ) : problem === "cli-missing" ? (
        <Notice>
          The boxd CLI is not installed. Install it from boxd.sh and run <code>boxd auth login</code>.
        </Notice>
      ) : error ? (
        <p className="mb-2 break-words text-destructive">{error}</p>
      ) : null}

      {rows?.length === 0 && <p className="text-muted-foreground">No machines yet.</p>}
      <ul className="space-y-1">
        {rows?.map((m) => (
          <MachineItem
            key={m.name}
            machine={m}
            current={m.name === branchVm}
            busy={busy[m.name]}
            run={(label, fn) => void run(m.name, label, fn)}
          />
        ))}
      </ul>
    </div>
  );
}

export function MachineItem({
  machine: m,
  current,
  busy,
  run,
}: {
  machine: MachineRow;
  current: boolean;
  busy: string | undefined;
  run: (label: string, fn: () => Promise<void>) => void;
}) {
  const openMachineTerminal = useAppStore((s) => s.openMachineTerminal);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const running = isRunning(m.status);

  return (
    <li className={`rounded-lg border px-2 py-1.5 ${current ? "border-accent-brand/60" : "border-border"}`}>
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${DOT[statusTone(m.status)]}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={m.url ?? m.name}>
          {m.name}
        </span>
        {current && <span className="text-[10px] text-accent-brand">this branch</span>}
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {busy ? `${busy}…` : [m.status, m.size].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <button onClick={() => openMachineTerminal(m.name)} disabled={!!busy} title={`boxd connect ${m.name}`} className={action}>
          Connect
        </button>
        <button
          onClick={() => void navigator.clipboard.writeText(`ssh ${m.name}.boxd`)}
          title={`Copy: ssh ${m.name}.boxd`}
          className={action}
        >
          Copy ssh
        </button>
        {running ? (
          <button onClick={() => run("Stopping", () => machineStop(m.name))} disabled={!!busy} className={action}>
            Stop
          </button>
        ) : canStart(m.status) ? (
          <button onClick={() => run("Starting", () => machineStart(m.name))} disabled={!!busy} className={action}>
            Start
          </button>
        ) : null}
        {m.owned && (
          <button
            onClick={() => setConfirming((c) => !c)}
            disabled={!!busy}
            className={`${action} hover:text-destructive`}
          >
            Delete
          </button>
        )}
      </div>
      {confirming && (
        <form
          className="mt-1.5 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirming(false);
            run("Deleting", () => machineRemove(m.name, typed));
            setTyped("");
          }}
        >
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Type ${m.name} to delete it`}
            spellCheck={false}
            className="h-6 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 font-mono text-[11px] outline-none focus:border-accent-brand"
          />
          <button type="submit" disabled={typed.trim() !== m.name} className={`${action} text-destructive`}>
            Delete
          </button>
        </form>
      )}
    </li>
  );
}

function NewMachine({
  initial,
  onCancel,
  onCreate,
}: {
  initial: string;
  onCancel: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="mb-3 rounded-lg border border-border p-2"
      onSubmit={(e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        onCreate(name)
          .catch((err) => setError(String(err)))
          .finally(() => setPending(false));
      }}
    >
      <div className="flex gap-1">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
          spellCheck={false}
          aria-label="Machine name"
          className="h-6 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 font-mono text-[11px] outline-none focus:border-accent-brand"
        />
        <button type="submit" disabled={pending || !name.trim()} className={action}>
          {pending ? "Creating…" : "Create"}
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className={action}>
          Cancel
        </button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Names start with <code>ph-</code>, so Powerhouse can delete it later. Creating takes up to a minute.
      </p>
      {error && <p className="mt-1 break-words text-destructive">{error}</p>}
    </form>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 rounded-lg border border-border bg-card px-2 py-1.5 text-muted-foreground">{children}</p>;
}
