import { useEffect, useRef, useState } from "react";
import { message } from "@tauri-apps/plugin-dialog";
import { cloudSettingsOf, useAppStore, type CloudSettings } from "../store/appStore";
import {
  cloudInspectSource,
  cloudLatestHandoff,
  cloudProbeBase,
  cloudSecretStatus,
  cloudSetSecret,
  cloudSubmit,
  type ProbeInfo,
  type SecretStatus,
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
  const [probe, setProbe] = useState<ProbeInfo | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [briefSource, setBriefSource] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [claudeInput, setClaudeInput] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);

  useEffect(() => {
    if (!modal) return;
    setTask("");
    setError(null);
    setBusy(false);
    setProbe(null);
    setProbeError(null);
    setSource(null);
    setSourceError(null);
    setCloud(cloudSettingsOf(useAppStore.getState().settings));
    setBrief("");
    setBriefSource(null);
    setSecretError(null);
    setClaudeInput("");
    setGithubInput("");
    requestAnimationFrame(() => taskRef.current?.focus());
    void cloudInspectSource(modal.sourcePath)
      .then(setSource)
      .catch((e) => setSourceError(String(e)));
    void cloudSecretStatus()
      .then((st) => {
        setSecrets(st);
        setSecretsOpen(!st.claude || !st.github);
      })
      .catch((e) => setSecretError(String(e)));
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
  const canSubmit = !!task.trim() && !!source && problems.length === 0 && !busy && !!cloud.baseVm.trim() && credsReady;

  const saveSecret = async (name: "claude_oauth_token" | "github_token", value: string) => {
    setSecretError(null);
    try {
      setSecrets(await cloudSetSecret(name, value));
      if (name === "claude_oauth_token") setClaudeInput("");
      else setGithubInput("");
    } catch (e) {
      setSecretError(String(e));
    }
  };

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    setProbeError(null);
    try {
      setProbe(await cloudProbeBase(cloud.baseVm.trim()));
    } catch (e) {
      setProbeError(String(e));
    } finally {
      setProbing(false);
    }
  };

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
        baseVm: cloud.baseVm.trim(),
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
          <Field label="Base VM">
            <div className="flex gap-1.5">
              <input
                value={cloud.baseVm}
                onChange={(e) => setCloud({ ...cloud, baseVm: e.target.value })}
                disabled={busy}
                spellCheck={false}
                className={`${input} font-mono`}
              />
              <button
                onClick={() => void runProbe()}
                disabled={busy || probing || !cloud.baseVm.trim()}
                title="Check the runner on this base VM"
                className="h-8 shrink-0 rounded-lg border border-border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {probing ? "Checking…" : "Check"}
              </button>
            </div>
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
              Claude {secrets?.claude ? "✓" : "missing"} · GitHub {secrets?.github ? "✓" : needsGit ? "missing" : "not needed"}
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
                  placeholder={secrets?.github ? "GitHub token (stored) — paste to replace" : "GitHub fine-grained token: this repo, contents: read & write"}
                  spellCheck={false}
                  className={`${input} font-mono`}
                />
                <button
                  onClick={() => void saveSecret("github_token", githubInput)}
                  disabled={!githubInput.trim() && !secrets?.github}
                  className="h-8 shrink-0 rounded-lg border border-border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {githubInput.trim() ? "Save" : "Clear"}
                </button>
              </div>
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

        {probe && (
          <p className="text-xs text-muted-foreground">
            Runner {probe.runner_version} (protocol {probe.protocol_version}) · Claude {probe.claude_version ?? "not installed"} · task VM will be{" "}
            <span className="font-mono">powerhouse-{modal.sourceLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}</span>
          </p>
        )}
        {probe && probe.ambient_secret_names.length > 0 && (
          <Problem>
            boxd injects org secrets into this machine's exec sessions ({probe.ambient_secret_names.join(", ")}). Runs never receive them, but remove
            them from boxd to keep Powerhouse machines clean.
          </Problem>
        )}
        {probeError && <Problem>{probeError}</Problem>}
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
