import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store/appStore";
import { runInShell } from "../lib/cloud";
import {
  canStart,
  isRunning,
  machineRemove,
  machineStart,
  machineStop,
  machinesList,
  machinesProblem,
  machinesSummary,
  statusTone,
  type MachineRow,
} from "../lib/machines";
import { RefreshIcon } from "./ui/icons";

const REFRESH_MS = 15_000;

const TONE = {
  on: "tone-running",
  busy: "tone-review animate-pulse",
  off: "text-muted-foreground/50",
};

/** Settings → Cloud → Machines: every boxd machine on the account. Chats create,
 *  suspend and retire their own VMs; this is for leftovers and the VM cap.
 *  Mounted only while the Cloud tab is open, so it polls only then. */
export function MachinesPane() {
  const repos = useAppStore((s) => s.repos);
  const branchId = useAppStore((s) => s.selection.branchId);
  const [rows, setRows] = useState<MachineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});

  /** VM name → the branch whose chat runs on it. */
  const usedBy = useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of repos) for (const b of repo.branches) if (b.vm) map.set(b.vm, `${repo.name} / ${b.name}`);
    return map;
  }, [repos]);

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
    <div className="text-[13px]">
      <div className="mb-2 flex h-7 items-center gap-2">
        <span className="flex-1 text-xs text-muted-foreground">{rows ? machinesSummary(rows) : "Loading…"}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh machines"
          className="ph-icon-btn disabled:[&_svg]:animate-spin"
        >
          <RefreshIcon className="size-3.5" />
        </button>
      </div>

      {problem === "signed-out" ? (
        <Notice>
          boxd is signed out.{" "}
          {branchId ? (
            <button type="button" onClick={() => runInShell(branchId, "boxd auth login")} className="underline hover:text-foreground">
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
        <p className="mb-2 select-text break-words font-mono text-xs text-destructive">{error}</p>
      ) : null}

      {rows?.length === 0 && <p className="text-xs text-muted-foreground">No machines.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-border rounded-[10px] border border-border">
          {rows.map((m) => (
            <MachineItem
              key={m.name}
              machine={m}
              usedBy={usedBy.get(m.name)}
              busy={busy[m.name]}
              run={(label, fn) => void run(m.name, label, fn)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function MachineItem({
  machine: m,
  usedBy,
  busy,
  run,
}: {
  machine: MachineRow;
  /** The branch whose chat runs on this VM; its lifecycle owns delete. */
  usedBy: string | undefined;
  busy: string | undefined;
  run: (label: string, fn: () => Promise<void>) => void;
}) {
  const openMachineTerminal = useAppStore((s) => s.openMachineTerminal);
  const setWorkspaceView = useAppStore((s) => s.setWorkspaceView);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const running = isRunning(m.status);
  const btn = "ph-btn h-7 px-2.5 text-xs";

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className={`ph-dot bg-current ${TONE[statusTone(m.status)]}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-foreground" title={m.url ?? m.name}>
            {m.name}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {busy ? `${busy}…` : [m.status, m.size, usedBy && `chat VM for ${usedBy}`].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => {
              // The terminal opens in the bottom panel of the branch view.
              setWorkspaceView("home");
              openMachineTerminal(m.name);
            }}
            disabled={!!busy}
            title={`boxd connect ${m.name}`}
            className={btn}
          >
            Connect
          </button>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(`ssh ${m.name}.boxd`)}
            title={`Copy: ssh ${m.name}.boxd`}
            className={btn}
          >
            Copy ssh
          </button>
          {running ? (
            <button type="button" onClick={() => run("Stopping", () => machineStop(m.name))} disabled={!!busy} className={btn}>
              Stop
            </button>
          ) : canStart(m.status) ? (
            <button type="button" onClick={() => run("Starting", () => machineStart(m.name))} disabled={!!busy} className={btn}>
              Start
            </button>
          ) : null}
          {m.owned && !usedBy && (
            <button
              type="button"
              onClick={() => setConfirming((c) => !c)}
              disabled={!!busy}
              aria-expanded={confirming}
              className={`${btn} ph-btn-ghost hover:!text-destructive`}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      {confirming && (
        <form
          className="mt-2 flex gap-1.5 pl-[1.1rem]"
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
            aria-label={`Type ${m.name} to confirm`}
            spellCheck={false}
            className="ph-input h-7 min-w-0 flex-1 px-2 font-mono text-xs"
          />
          <button type="submit" disabled={typed.trim() !== m.name} className={`${btn} ph-btn-danger`}>
            Delete
          </button>
        </form>
      )}
    </li>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 rounded-[10px] border border-border px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}
