import { useEffect, useRef, useState } from "react";
import { message } from "@tauri-apps/plugin-dialog";
import { cloudSettingsOf, useAppStore, type CloudSettings } from "../store/appStore";
import {
  cloudInspectSource,
  cloudLatestHandoff,
  cloudListSnapshots,
  cloudSecretStatus,
  cloudSetSecret,
  cloudSubmit,
  remoteOwner,
  type SecretStatus,
  type SnapshotInfo,
  type SourceInfo,
} from "../lib/cloud";
import { shortSha } from "../lib/cloudView";

const input =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

export function CloudRunModal() {
  const modal = useAppStore((s) => s.cloudModal);
  const repo = useAppStore((s) => s.repos.find((r) => r.id === s.cloudModal?.repoId) ?? null);
  const settings = useAppStore((s) => s.settings);
  const close = useAppStore((s) => s.closeCloudModal);
  const setCloudSettings = useAppStore((s) => s.setCloudSettings);
  const setCloudRun = useAppStore((s) => s.setCloudRun);
  const openRightTab = useAppStore((s) => s.openRightTab);

  const taskRef = useRef<HTMLTextAreaElement>(null);
  const [task, setTask] = useState("");
  const [cloud, setCloud] = useState<CloudSettings>(cloudSettingsOf(settings));
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  /** The base snapshot as listed when the form opened; its version is pinned into the run. */
  const [snapshot, setSnapshot] = useState<SnapshotInfo | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [briefSource, setBriefSource] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [claudeInput, setClaudeInput] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [githubScope, setGithubScope] = useState<"owner" | "all" | "repo">("owner");
  const [secretError, setSecretError] = useState<string | null>(null);

  useEffect(() => {
    if (!modal) return;
    setTask("");
    setError(null);
    setBusy(false);
    setSnapshot(null);
    setSnapshotError(null);
    setSource(null);
    setSourceError(null);
    setCloud(cloudSettingsOf(useAppStore.getState().settings));
    setBrief("");
    setBriefSource(null);
    setSecretError(null);
    setClaudeInput("");
    setGithubInput("");
    requestAnimationFrame(() => taskRef.current?.focus());
    void lookupSnapshot(cloudSettingsOf(useAppStore.getState().settings).baseSnapshot);
    void cloudInspectSource(modal.sourcePath)
      .then((src) => {
        setSource(src);
        return cloudSecretStatus(src.remote_url);
      })
      .then((st) => {
        setSecrets(st);
        setSecretsOpen(!st.claude || !st.github);
      })
      .catch((e) => setSourceError(String(e)));
    // The handoff document is the plan Powerhouse already produces; offer it as the brief.
    void cloudLatestHandoff(modal.sourcePath)
      .then((doc) => {
        if (doc) {
          setBrief(doc.content);
          setBriefSource(doc.path.split("/").slice(-1)[0]);
        }
      })
      .catch(() => {});
  }, [modal]);

  if (!modal || !repo) return null;

  const checks = repo.workflow.map((w) => ({ name: w.name, command: w.command })).filter((c) => c.command.trim());
  const problems = source?.problems ?? [];
  const needsGit = !!source?.remote_url?.startsWith("https://");
  const credsReady = !!secrets && secrets.claude && (!needsGit || secrets.github);
  const canSubmit = !!task.trim() && !!source && problems.length === 0 && !busy && !!snapshot && credsReady;

  const owner = remoteOwner(source?.remote_url);
  const repoSlug = source?.remote_url ? /\/([^/]+?)(?:\.git)?$/.exec(source.remote_url)?.[1] ?? null : null;
  const githubSlotName =
    githubScope === "all" || !owner
      ? "github_token"
      : githubScope === "repo" && repoSlug
        ? `github_token:${owner}/${repoSlug}`
        : `github_token:${owner}`;

  const saveSecret = async (name: string, value: string) => {
    setSecretError(null);
    try {
      setSecrets(await cloudSetSecret(name, value, source?.remote_url));
      if (name === "claude_oauth_token") setClaudeInput("");
      else setGithubInput("");
    } catch (e) {
      setSecretError(String(e));
    }
  };

  async function lookupSnapshot(name: string) {
    const wanted = name.trim();
    setChecking(true);
    setSnapshot(null);
    setSnapshotError(null);
    try {
      const rows = await cloudListSnapshots();
      const row = rows.find((r) => r.name === wanted);
      if (!row) {
        setSnapshotError(
          `Snapshot \`${wanted}\` is not in your boxd org${rows.length ? ` (available: ${rows.map((r) => r.name).join(", ")})` : ""}. Publish it with scripts/cloud-base-setup.sh --publish-snapshot ${wanted}.`,
        );
      } else if (row.status !== "ready") {
        setSnapshotError(`Snapshot \`${wanted}\` is ${row.status}, not ready.`);
      } else {
        setSnapshot(row);
      }
    } catch (e) {
      setSnapshotError(String(e));
    } finally {
      setChecking(false);
    }
  }

  const submit = async () => {
    if (!canSubmit || !source) return;
    setBusy(true);
    setError(null);
    setCloudSettings(cloud);
    try {
      const rec = await cloudSubmit({
        repoId: repo.id,
        repoPath: repo.path,
        repoName: repo.name,
        sourcePath: modal.sourcePath,
        task: task.trim(),
        acceptanceCriteria: [],
        baseSnapshot: cloud.baseSnapshot.trim(),
        baseSnapshotVersion: snapshot?.version ?? null,
        machineCeiling: cloud.machineCeiling,
        checks,
        deadlineSeconds: Math.max(1, Math.round(cloud.deadlineMinutes)) * 60,
        permissionMode: cloud.permissionMode,
        allowedTools: cloud.allowedTools.split(",").map((t) => t.trim()).filter(Boolean),
        maxTurns: cloud.maxTurns,
        maxBudgetUsd: cloud.maxBudgetUsd,
        model: cloud.model.trim() || null,
        provider: "claude",
        brief,
      });
      setCloudRun(rec);
      close();
      openRightTab("cloud");
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-background/60 pt-16"
      onMouseDown={() => !busy && close()}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[36rem] flex-col gap-3 overflow-y-auto rounded-xl bg-card p-4 ring-1 ring-foreground/10"
      >
        <div>
          <p className="font-medium">Run in cloud</p>
          <p className="text-xs text-muted-foreground">
            {repo.name} · <span className="font-mono">{modal.sourceLabel}</span>
            {source && (
              <>
                {" "}at <span className="font-mono">{shortSha(source.sha)}</span>
              </>
            )}
          </p>
        </div>

        {sourceError && <Problem>{sourceError}</Problem>}
        {problems.map((p) => (
          <Problem key={p}>{p}</Problem>
        ))}
        {source && problems.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Source verified on <span className="font-mono">{source.remote_url}</span>. The VM fetches exactly this commit.
          </p>
        )}

        <textarea
          ref={taskRef}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) close();
            if (e.key === "Enter" && e.metaKey) void submit();
          }}
          disabled={busy}
          placeholder="What should the agent do? Be specific about the outcome and how to verify it."
          spellCheck={false}
          rows={6}
          className="w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-xs leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />

        <div className="grid grid-cols-2 gap-2">
          <Field label="Base snapshot">
            <div className="flex gap-1.5">
              <input
                value={cloud.baseSnapshot}
                onChange={(e) => {
                  setCloud({ ...cloud, baseSnapshot: e.target.value });
                  setSnapshot(null);
                  setSnapshotError(null);
                }}
                onBlur={() => !snapshot && cloud.baseSnapshot.trim() && void lookupSnapshot(cloud.baseSnapshot)}
                disabled={busy}
                spellCheck={false}
                className={`${input} font-mono`}
              />
              <button
                onClick={() => void lookupSnapshot(cloud.baseSnapshot)}
                disabled={busy || checking || !cloud.baseSnapshot.trim()}
                title="Look the snapshot up in boxd (name, version, size)"
                className="h-8 shrink-0 rounded-lg border border-border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {checking ? "Checking…" : "Check"}
              </button>
            </div>
          </Field>
          <Field label="Machine ceiling (org has 20 slots)">
            <input
              type="number"
              min={1}
              max={20}
              value={cloud.machineCeiling}
              onChange={(e) => setCloud({ ...cloud, machineCeiling: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
              disabled={busy}
              title="Refuse to create a VM when the org already has this many machines"
              className={input}
            />
          </Field>
          <Field label="Deadline (minutes)">
            <input
              type="number"
              min={1}
              max={1440}
              value={cloud.deadlineMinutes}
              onChange={(e) => setCloud({ ...cloud, deadlineMinutes: Number(e.target.value) })}
              disabled={busy}
              className={input}
            />
          </Field>
          <Field label="Permission mode">
            <select
              value={cloud.permissionMode}
              onChange={(e) => setCloud({ ...cloud, permissionMode: e.target.value })}
              disabled={busy}
              className={input}
            >
              <option value="acceptEdits">acceptEdits</option>
              <option value="dontAsk">dontAsk</option>
              <option value="plan">plan</option>
            </select>
          </Field>
          <Field label="Model (optional)">
            <input
              value={cloud.model}
              onChange={(e) => setCloud({ ...cloud, model: e.target.value })}
              disabled={busy}
              spellCheck={false}
              placeholder="provider default"
              className={`${input} font-mono`}
            />
          </Field>
          <Field label="Max turns">
            <input
              type="number"
              min={1}
              value={cloud.maxTurns ?? ""}
              onChange={(e) => setCloud({ ...cloud, maxTurns: e.target.value ? Number(e.target.value) : null })}
              disabled={busy}
              className={input}
            />
          </Field>
          <Field label="Budget limit (USD, estimate)">
            <input
              type="number"
              min={0}
              step={0.5}
              value={cloud.maxBudgetUsd ?? ""}
              onChange={(e) => setCloud({ ...cloud, maxBudgetUsd: e.target.value ? Number(e.target.value) : null })}
              disabled={busy}
              className={input}
            />
          </Field>
        </div>
        <Field label="Allowed tools (comma-separated)">
          <input
            value={cloud.allowedTools}
            onChange={(e) => setCloud({ ...cloud, allowedTools: e.target.value })}
            disabled={busy}
            spellCheck={false}
            className={`${input} font-mono`}
          />
        </Field>

        <Field
          label={
            briefSource
              ? `Plan and context (prefilled from ${briefSource}; written to .powerhouse/cloud-task.md in the VM)`
              : "Plan and context (optional; written to .powerhouse/cloud-task.md in the VM)"
          }
        >
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            disabled={busy}
            spellCheck={false}
            rows={5}
            placeholder="Goal, plan of execution, decisions so far, files of interest, definition of done."
            className="w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          />
        </Field>

        <div className="rounded-lg border border-border p-2.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wider text-[11px] text-muted-foreground">Powerhouse credentials</span>
            <span className="text-muted-foreground">
              Claude {secrets?.claude ? "✓" : "missing"} · GitHub{" "}
              {secrets?.github ? (
                <>
                  ✓ <span className="font-mono">{secrets.github_slot}</span>
                </>
              ) : needsGit ? (
                "missing"
              ) : (
                "not needed"
              )}
            </span>
            <button
              onClick={() => setSecretsOpen((o) => !o)}
              className="ml-auto h-6 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {secretsOpen ? "Hide" : "Edit"}
            </button>
          </div>
          {secretsOpen && (
            <div className="mt-2 space-y-2">
              <p className="text-muted-foreground">
                Stored in your macOS Keychain and sent to the task VM only for the duration of a run; the runner shreds them when the run ends.
                Nothing from boxd or your other tools is used.
              </p>
              <div className="flex gap-1.5">
                <input
                  type="password"
                  value={claudeInput}
                  onChange={(e) => setClaudeInput(e.target.value)}
                  placeholder={secrets?.claude ? "Claude OAuth token (stored) — paste to replace" : "Claude OAuth token from `claude setup-token`"}
                  spellCheck={false}
                  className={`${input} font-mono`}
                />
                <button
                  onClick={() => void saveSecret("claude_oauth_token", claudeInput)}
                  disabled={!claudeInput.trim() && !secrets?.claude}
                  className="h-8 shrink-0 rounded-lg border border-border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {claudeInput.trim() ? "Save" : "Clear"}
                </button>
              </div>
              <div className="flex gap-1.5">
                <input
                  type="password"
                  value={githubInput}
                  onChange={(e) => setGithubInput(e.target.value)}
                  placeholder="GitHub fine-grained token, Contents: read & write"
                  spellCheck={false}
                  className={`${input} font-mono`}
                />
                <select
                  value={githubScope}
                  onChange={(e) => setGithubScope(e.target.value as "owner" | "all" | "repo")}
                  title="Which Keychain slot this token fills. Powerhouse picks the most specific slot for a run's remote."
                  className="h-8 shrink-0 rounded-lg border border-input bg-background px-2 text-xs outline-none"
                >
                  {owner && <option value="owner">for {owner}</option>}
                  {owner && repoSlug && <option value="repo">only {owner}/{repoSlug}</option>}
                  <option value="all">any owner</option>
                </select>
                <button
                  onClick={() => void saveSecret(githubSlotName, githubInput)}
                  disabled={!githubInput.trim()}
                  className="h-8 shrink-0 rounded-lg border border-border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  Save
                </button>
              </div>
              <p className="text-muted-foreground">
                GitHub fine-grained tokens cover one owner. Store one per owner you develop under ("for {owner ?? "owner"}", all its repositories), or narrow a sensitive repo with its own token. Saves to <span className="font-mono">{githubSlotName}</span>.
              </p>
              {secretError && <Problem>{secretError}</Problem>}
            </div>
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          <p className="mb-1 font-semibold uppercase tracking-wider text-[11px]">Checks after the agent finishes</p>
          {checks.length === 0 ? (
            <p>None configured — the result will say “No validation configured”. Edit the merge workflow to add checks.</p>
          ) : (
            <ul className="space-y-0.5">
              {checks.map((c, i) => (
                <li key={i} className="font-mono">
                  {c.name ? `${c.name}: ` : ""}
                  {c.command}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1">Checks run on Linux in the VM; macOS-only steps will fail there.</p>
        </div>

        {snapshot && (
          <p className="text-xs text-muted-foreground">
            Base <span className="font-mono">{snapshot.name}</span> {snapshot.version ?? ""}
            {snapshot.size ? ` · ${snapshot.size}` : ""} · a fresh isolated <span className="font-mono">ph-&lt;run&gt;</span> VM is created from it
            for this run and destroyed once the result is fetched and verified. The runner is checked on that VM before the task is submitted.
          </p>
        )}
        {snapshotError && <Problem>{snapshotError}</Problem>}
        {error && <Problem>{error}</Problem>}

        <div className="flex items-center justify-end gap-2">
          {busy && <span className="mr-auto text-xs text-muted-foreground">Preparing cloud environment… keep the app open until accepted.</span>}
          <button
            onClick={() => close()}
            disabled={busy}
            className="h-8 rounded-lg px-3 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={!canSubmit}
            title="⌘↩"
            className="h-8 rounded-lg bg-primary px-4 font-medium text-primary-foreground transition-all active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Run in cloud"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p className="select-text whitespace-pre-wrap rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-xs text-destructive">
      {children}
    </p>
  );
}

export async function showError(title: string, err: unknown) {
  await message(String(err), { title, kind: "error" });
}
