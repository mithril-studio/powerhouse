import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, DEFAULT_CLOUD_SETTINGS } from "../../store/appStore";
import { newScriptDraft, newWorkflowDraft, type WorkflowDraft } from "./workflowDrafts";
import {
  cancelRun,
  coordinatorHealthy,
  draftContentKey,
  getRun,
  isTerminal,
  publishDraft,
  startRun,
  storeToken,
  tokenStored,
  type RunDetail,
} from "../../lib/coordinator";

const field = "w-full border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";
const button = "pi-btn px-3 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-ring";

const POLL_MS = 3000;

type Health = "unconfigured" | "checking" | "ok" | "down";

const STATUS_TONE: Record<string, string> = {
  succeeded: "text-success",
  failed: "text-destructive",
  canceled: "text-muted-foreground",
  interrupted: "text-destructive",
  skipped: "text-muted-foreground",
};

export function WorkflowsPage() {
  const repos = useAppStore((s) => s.repos);
  const hydrated = useAppStore((s) => s.hydrated);
  const drafts = useAppStore((s) => s.workflowDrafts);
  const save = useAppStore((s) => s.saveWorkflowDraft);
  const selectedRepoId = useAppStore((s) => s.selection.repoId);
  const coordinatorUrl = useAppStore((s) => s.settings.coordinatorUrl ?? "");
  const setCoordinatorUrl = useAppStore((s) => s.setCoordinatorUrl);
  const snapshotName = useAppStore(
    (s) => s.settings.cloud?.baseSnapshot ?? DEFAULT_CLOUD_SETTINGS.baseSnapshot,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const draft = drafts.find((d) => d.id === selectedId) ?? drafts[0];
  const step = draft?.steps.find((s) => s.id === stepId) ?? draft?.steps[0];
  const stepIndex = draft?.steps.findIndex((s) => s.id === step?.id) ?? -1;

  // --- coordinator connection ------------------------------------------------
  const [health, setHealth] = useState<Health>("unconfigured");
  const [hasToken, setHasToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const checkHealth = useCallback(async (url: string) => {
    if (!url.trim()) {
      setHealth("unconfigured");
      return;
    }
    setHealth("checking");
    setHealth((await coordinatorHealthy(url.trim())) ? "ok" : "down");
  }, []);

  useEffect(() => {
    tokenStored().then(setHasToken).catch(() => setHasToken(false));
    void checkHealth(coordinatorUrl);
    // Deliberately mount-only: later checks run on explicit Connect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    setConnectionError(null);
    try {
      if (tokenInput.trim()) {
        await storeToken(tokenInput);
        setTokenInput("");
        setHasToken(true);
      }
      await checkHealth(coordinatorUrl);
    } catch (e) {
      setConnectionError(String(e));
    }
  };

  const connected = health === "ok" && hasToken;

  // --- publish / run ---------------------------------------------------------
  const [busy, setBusy] = useState<"publish" | "run" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const repoOf = (d: WorkflowDraft) => repos.find((r) => r.id === d.repoId);

  const publish = async () => {
    if (!draft) return;
    const repo = repoOf(draft);
    if (!repo) return setActionError("This draft's project is no longer open in Powerhouse.");
    setBusy("publish");
    setActionError(null);
    try {
      const { workflowId, version } = await publishDraft(coordinatorUrl, draft, repo.path, snapshotName);
      save({ ...draft, serverWorkflowId: workflowId, publishedVersion: version, publishedKey: draftContentKey(draft) });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!draft) return;
    const repo = repoOf(draft);
    if (!repo) return setActionError("This draft's project is no longer open in Powerhouse.");
    setBusy("run");
    setActionError(null);
    try {
      const runId = await startRun(coordinatorUrl, draft, repo.path);
      save({ ...draft, runIds: [runId, ...(draft.runIds ?? []).filter((id) => id !== runId)].slice(0, 20) });
      setSelectedRunId(runId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // --- run detail polling ----------------------------------------------------
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const runIds = draft?.runIds ?? [];
  const activeRunId = selectedRunId && runIds.includes(selectedRunId) ? selectedRunId : (runIds[0] ?? null);

  useEffect(() => {
    if (!activeRunId || !coordinatorUrl || !hasToken) {
      setRunDetail(null);
      return;
    }
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const detail = await getRun(coordinatorUrl, activeRunId);
        if (stop) return;
        setRunDetail(detail);
        setRunError(null);
        if (!isTerminal(detail.run.status)) timer = window.setTimeout(tick, POLL_MS);
      } catch (e) {
        if (stop) return;
        setRunDetail(null);
        setRunError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [activeRunId, coordinatorUrl, hasToken]);

  const cancel = async () => {
    if (!activeRunId) return;
    try {
      await cancelRun(coordinatorUrl, activeRunId);
      setRunDetail((d) => (d ? { ...d, run: { ...d.run, cancelRequested: true } } : d));
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { heading.current?.focus(); }, []);

  const patch = (fields: Partial<WorkflowDraft>) => { if (draft) save({ ...draft, ...fields }); };
  const patchStep = (fields: { name?: string; command?: string }) => {
    if (draft && step) patch({ steps: draft.steps.map((s) => s.id === step.id ? { ...s, ...fields } : s) });
  };
  const create = () => {
    const repoId = repos.find((r) => r.id === selectedRepoId)?.id ?? repos[0]?.id;
    if (!hydrated || !repoId) return;
    const created = newWorkflowDraft(repoId);
    save(created);
    setSelectedId(created.id);
    setStepId(created.steps[0].id);
  };
  const addStep = () => {
    if (!draft) return;
    const added = newScriptDraft();
    patch({ steps: [...draft.steps, added] });
    setStepId(added.id);
  };
  const move = (direction: -1 | 1) => {
    if (!draft || stepIndex < 0) return;
    const nextIndex = stepIndex + direction;
    if (nextIndex < 0 || nextIndex >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[stepIndex], steps[nextIndex]] = [steps[nextIndex], steps[stepIndex]];
    patch({ steps });
  };

  const dirty = draft?.publishedKey !== undefined && draft.publishedKey !== draftContentKey(draft);
  const published = draft?.serverWorkflowId !== undefined;
  const runActive = runDetail !== null && !isTerminal(runDetail.run.status);

  return (
    <main aria-labelledby="workflows-title" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div data-tauri-drag-region className="h-11 shrink-0 border-b border-border" />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h1 ref={heading} tabIndex={-1} id="workflows-title" className="text-base font-semibold outline-none">Workflows</h1>
          <p className="mt-1 text-xs text-muted-foreground">Build a script sequence, publish it, and run it on cloud VMs.</p>
        </div>
        <button type="button" className={`${button} pi-btn-primary`} disabled={!hydrated || repos.length === 0} onClick={create}>+ New workflow</button>
      </header>

      {/* Coordinator connection bar */}
      <div className="border-b border-border bg-card px-5 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            aria-hidden="true"
            className={`inline-block size-2 rounded-full ${health === "ok" ? "bg-success" : health === "down" ? "bg-destructive" : "bg-muted-foreground/40"}`}
          />
          <span role="status" className="mr-2">
            {health === "unconfigured" && "Coordinator not configured"}
            {health === "checking" && "Checking coordinator…"}
            {health === "down" && "Coordinator unreachable"}
            {health === "ok" && (hasToken ? "Connected to coordinator" : "Coordinator reachable — add your API token")}
          </span>
          <input
            className={`${field} max-w-64 flex-1`}
            placeholder="https://coordinator… or http://127.0.0.1:8787"
            aria-label="Coordinator URL"
            value={coordinatorUrl}
            onChange={(e) => setCoordinatorUrl(e.target.value)}
          />
          <input
            className={`${field} max-w-52 flex-1`}
            type="password"
            aria-label="Coordinator API token"
            placeholder={hasToken ? "Token stored in Keychain" : "API token"}
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
          />
          <button type="button" className={button} onClick={() => void connect()}>Connect</button>
        </div>
        {connectionError && <p className="mt-2 text-xs text-destructive">{connectionError}</p>}
        <p className="mt-2 text-[11px] text-muted-foreground">The token is stored in the macOS Keychain, never on disk. Keep secrets out of commands.</p>
      </div>

      {!hydrated ? <p role="status" className="p-5 text-muted-foreground">Loading workflows…</p> : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row">
          <section aria-label="Workflow drafts" className="shrink-0 border-b border-border p-4 lg:w-52 lg:overflow-y-auto lg:border-r lg:border-b-0">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workflows · {drafts.length}</h2>
            {drafts.length === 0 && <p className="text-xs text-muted-foreground">Your workflows will appear here.</p>}
            <div className="space-y-1">
              {drafts.map((item) => (
                <button key={item.id} type="button" aria-pressed={draft?.id === item.id} onClick={() => { setSelectedId(item.id); setStepId(null); setSelectedRunId(null); }}
                  className={`w-full border p-2 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring ${draft?.id === item.id ? "border-accent-brand bg-card" : "border-transparent hover:bg-muted"}`}>
                  <span className="block truncate">{item.name.trim() || "Untitled workflow"}</span>
                  <span className="mt-1 block truncate text-muted-foreground">
                    {repos.find((r) => r.id === item.repoId)?.name ?? "Project unavailable"}
                    {item.publishedVersion ? ` · v${item.publishedVersion}` : " · draft"}
                  </span>
                </button>
              ))}
            </div>
          </section>
          {!draft ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <h2 className="text-sm font-medium">No workflows yet</h2>
              <p className="max-w-sm text-xs text-muted-foreground">{repos.length === 0 ? "Add a project using the left sidebar, then create your first workflow." : "Start with a script, then add the steps that should follow it."}</p>
              {repos.length > 0 && <button type="button" className={button} onClick={create}>Create first workflow</button>}
            </div>
          ) : <>
            <section aria-label="Script sequence" className="flex min-w-0 flex-1 flex-col p-5 lg:overflow-y-auto">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">
                  Sequence{" "}
                  <span className="text-xs text-muted-foreground">
                    {published ? `/ v${draft.publishedVersion}${dirty ? " · unpublished changes" : ""}` : "/ draft"}
                  </span>
                </h2>
                <div className="flex gap-2">
                  <button type="button" className={button} disabled={!connected || busy !== null} onClick={() => void publish()}>
                    {busy === "publish" ? "Publishing…" : published ? "Publish new version" : "Publish"}
                  </button>
                  <button type="button" className={`${button} pi-btn-primary`} disabled={!connected || !published || busy !== null} onClick={() => void run()}>
                    {busy === "run" ? "Starting…" : "Run"}
                  </button>
                </div>
              </div>
              {!connected && (
                <p className="mb-5 text-xs text-muted-foreground">Connect the coordinator above to publish and run.</p>
              )}
              {actionError && <p role="alert" className="mb-5 text-xs text-destructive">{actionError}</p>}
              <ol className="space-y-2">
                {draft.steps.map((item, index) => <li key={item.id}>
                  {index > 0 && <div aria-hidden="true" className="mb-2 text-center text-muted-foreground">↓</div>}
                  <button type="button" aria-pressed={step?.id === item.id} onClick={() => setStepId(item.id)}
                    className={`w-full border bg-card p-3 text-left focus-visible:ring-2 focus-visible:ring-ring ${step?.id === item.id ? "border-accent-brand" : "border-border hover:border-input"}`}>
                    <span className="text-[11px] text-muted-foreground">{index + 1} · SCRIPT</span>
                    <span className="mt-1 block text-sm">{item.name.trim() || "Untitled script"}</span>
                    <span className="mt-2 block truncate font-mono text-xs text-muted-foreground">{item.command.trim() || "Select to add a command"}</span>
                  </button>
                </li>)}
              </ol>
              <button type="button" onClick={addStep} className={`${button} mt-3 w-full`}>+ Add script</button>

              <div className="mt-8 border-t border-border pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-xs font-medium">Run history</h2>
                  {runActive && (
                    <button type="button" className={button} onClick={() => void cancel()} disabled={runDetail?.run.cancelRequested}>
                      {runDetail?.run.cancelRequested ? "Canceling…" : "Cancel run"}
                    </button>
                  )}
                </div>
                {runIds.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">No runs yet. Publish, then press Run.</p>
                ) : (
                  <>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {runIds.map((id, i) => (
                        <button key={id} type="button" aria-pressed={id === activeRunId} onClick={() => setSelectedRunId(id)}
                          className={`border px-2 py-1 font-mono text-[11px] focus-visible:ring-2 focus-visible:ring-ring ${id === activeRunId ? "border-accent-brand bg-card" : "border-border text-muted-foreground hover:bg-muted"}`}>
                          {runIds.length - i}: {id.slice(0, 8)}
                        </button>
                      ))}
                    </div>
                    {runError && <p role="alert" className="mt-3 text-xs text-destructive">{runError}</p>}
                    {runDetail && (
                      <div className="mt-3 border border-border bg-card p-3">
                        <p className="text-xs">
                          <span className={`font-medium ${STATUS_TONE[runDetail.run.status] ?? ""}`}>{runDetail.run.status}</span>
                          <span className="text-muted-foreground"> · {runDetail.run.repoName} @ {runDetail.run.commitSha.slice(0, 10)}
                            {runDetail.run.workflowVersion ? ` · v${runDetail.run.workflowVersion}` : ""}</span>
                        </p>
                        {runDetail.run.error && <p className="mt-1 text-xs text-destructive">{runDetail.run.error}</p>}
                        <ol className="mt-3 space-y-2">
                          {runDetail.run.nodes.map((node, i) => {
                            const nodeRun = runDetail.nodes.find((n) => n.nodeIndex === i);
                            const state = nodeRun?.state ?? "pending";
                            return (
                              <li key={node.name} className="border border-border bg-background p-2">
                                <p className="text-xs">
                                  <span className="text-muted-foreground">{i + 1} · </span>{node.name}
                                  <span className={`float-right ${STATUS_TONE[state] ?? "text-muted-foreground"}`}>
                                    {state}{nodeRun?.exitCode !== null && nodeRun?.exitCode !== undefined ? ` (exit ${nodeRun.exitCode})` : ""}
                                  </span>
                                </p>
                                {nodeRun?.error && <p className="mt-1 text-xs text-destructive">{nodeRun.error}</p>}
                                {nodeRun?.outputTail && (
                                  <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all bg-muted p-2 font-mono text-[11px] text-muted-foreground">{nodeRun.outputTail}</pre>
                                )}
                              </li>
                            );
                          })}
                        </ol>
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
            <section aria-label="Workflow configuration" className="shrink-0 border-t border-border bg-card p-4 lg:w-64 lg:overflow-y-auto lg:border-t-0 lg:border-l">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Configuration</h2>
              <label className="mb-4 block text-xs">Workflow name<input className={`${field} mt-1`} value={draft.name} maxLength={200} onChange={(e) => patch({ name: e.target.value })} /></label>
              <label className="mb-5 block text-xs">Project<select className={`${field} mt-1`} value={draft.repoId} onChange={(e) => patch({ repoId: e.target.value })}>
                {!repos.some((r) => r.id === draft.repoId) && <option value={draft.repoId}>Project unavailable</option>}
                {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select></label>
              {step ? <div className="border-t border-border pt-4">
                <h3 className="mb-3 text-xs font-medium">Script {stepIndex + 1}</h3>
                <label className="mb-4 block text-xs">Step name<input className={`${field} mt-1`} maxLength={200} value={step.name} onChange={(e) => patchStep({ name: e.target.value })} /></label>
                <label className="block text-xs">Command<textarea className={`${field} mt-1 min-h-36 resize-y font-mono`} spellCheck={false} maxLength={65536} placeholder="e.g. pnpm test" value={step.command} onChange={(e) => patchStep({ command: e.target.value })} /></label>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={button} onClick={() => move(-1)} disabled={stepIndex === 0} aria-label="Move script up">↑</button>
                  <button type="button" className={button} onClick={() => move(1)} disabled={stepIndex === draft.steps.length - 1} aria-label="Move script down">↓</button>
                  <button type="button" className={button} onClick={() => { patch({ steps: draft.steps.filter((s) => s.id !== step.id) }); setStepId(null); }}>Remove step</button>
                </div>
              </div> : <p className="text-xs text-muted-foreground">Add a script to configure it.</p>}
              <p className="mt-5 text-[11px] text-muted-foreground">Draft edits are saved on this Mac. Runs execute the last published version against the remote branch head on snapshot “{snapshotName}”.</p>
            </section>
          </>}
        </div>
      )}
    </main>
  );
}
