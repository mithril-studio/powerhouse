import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { homeDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  cloudSettingsOf,
  useAppStore,
  type AgentProfile,
  type CloudSettings,
  type Theme,
} from "../store/appStore";
import { cloudSecretStatus, cloudSetSecret, type SecretStatus } from "../lib/cloud";
import {
  disposeTerminal,
  fitTerminal,
  spawnTerminal,
} from "../lib/terminalRegistry";
import {
  githubDeviceStart,
  githubDisconnect,
  githubPoll,
  type DeviceStart,
} from "../lib/ipc";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where a user fully revokes access — local disconnect can't (no client secret). */
const GITHUB_APPS_URL = "https://github.com/settings/applications";

/** A section block: left-hand label/description, right-hand controls. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid grid-cols-[minmax(0,12rem)_1fr] gap-6 border-t border-border py-6 first:border-t-0 first:pt-0">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function AccountSection() {
  const github = useAppStore((s) => s.settings.connections.github);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const connected = github.status === "connected";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
      {connected && github.avatarUrl ? (
        <img
          src={github.avatarUrl}
          alt=""
          className="size-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-base font-semibold text-primary-foreground">
          P
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {connected && github.login ? github.login : "Powerhouse account"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {connected
            ? `Signed in with GitHub as @${github.login}`
            : "Not signed in"}
        </p>
      </div>
      {version && (
        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          v{version}
        </span>
      )}
    </div>
  );
}

function AppearanceSection() {
  const theme = useAppStore((s) => s.settings.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const options: { value: Theme; label: string }[] = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ];

  return (
    <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          className={`h-8 rounded-md px-4 text-xs font-medium transition-colors ${
            theme === opt.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ConnectionsSection() {
  const github = useAppStore((s) => s.settings.connections.github);
  const setGithubConnection = useAppStore((s) => s.setGithubConnection);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Guards the async poll loop so Cancel / unmount stops it cleanly.
  const activeRef = useRef(false);

  useEffect(
    () => () => {
      activeRef.current = false;
    },
    [],
  );

  const { status } = github;

  function finishDisconnected() {
    activeRef.current = false;
    setDevice(null);
    setGithubConnection({ status: "disconnected" });
  }

  async function pollLoop(start: DeviceStart) {
    let interval = start.interval;
    const deadline = Date.now() + start.expires_in * 1000;
    while (activeRef.current) {
      await sleep(interval * 1000);
      if (!activeRef.current) return;
      if (Date.now() > deadline) {
        setError("The device code expired. Please try connecting again.");
        finishDisconnected();
        return;
      }
      try {
        const result = await githubPoll(start.device_code);
        if (!activeRef.current) return;
        if (result.status === "pending") continue;
        if (result.status === "slow_down") {
          interval = result.interval;
          continue;
        }
        // Connected — token is now in the Rust keychain.
        activeRef.current = false;
        setDevice(null);
        setGithubConnection({
          status: "connected",
          login: result.login,
          avatarUrl: result.avatar_url,
        });
        return;
      } catch (e) {
        setError(String(e));
        finishDisconnected();
        return;
      }
    }
  }

  async function connect() {
    setError(null);
    setCopied(false);
    setGithubConnection({ status: "connecting" });
    let start: DeviceStart;
    try {
      start = await githubDeviceStart();
    } catch (e) {
      setError(String(e));
      setGithubConnection({ status: "disconnected" });
      return;
    }
    setDevice(start);
    await openUrl(start.verification_uri).catch(() => {});
    activeRef.current = true;
    void pollLoop(start);
  }

  async function disconnect() {
    await githubDisconnect().catch(() => {});
    finishDisconnected();
  }

  async function copyCode() {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.user_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the code is shown for manual entry */
    }
  }

  const dotClass =
    status === "connected"
      ? "bg-success"
      : status === "connecting"
        ? "bg-primary animate-pulse"
        : "bg-muted-foreground/40";

  const label =
    status === "connected"
      ? github.login
        ? `Connected as @${github.login}`
        : "Connected"
      : status === "connecting"
        ? "Waiting for authorization…"
        : "Not connected";

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-3">
        <span className={`size-2 shrink-0 rounded-full ${dotClass}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">GitHub</p>
          <p className="truncate text-xs text-muted-foreground">{label}</p>
        </div>
        {status === "connected" ? (
          <button
            onClick={() => void disconnect()}
            className="h-8 shrink-0 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition-all hover:text-foreground active:translate-y-px"
          >
            Disconnect
          </button>
        ) : status === "connecting" ? (
          <button
            onClick={finishDisconnected}
            className="h-8 shrink-0 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition-all hover:text-foreground active:translate-y-px"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={() => void connect()}
            className="h-8 shrink-0 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Connect
          </button>
        )}
      </div>

      {status === "connecting" && device && (
        <div className="mt-3 rounded-lg border border-border bg-background p-3">
          <p className="text-xs text-muted-foreground">
            Enter this code at{" "}
            <button
              onClick={() => void openUrl(device.verification_uri)}
              className="font-medium text-foreground underline underline-offset-2"
            >
              {device.verification_uri.replace(/^https?:\/\//, "")}
            </button>
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-lg tracking-[0.3em] text-foreground">
              {device.user_code}
            </code>
            <button
              onClick={() => void copyCode()}
              className="h-8 shrink-0 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition-all hover:text-foreground active:translate-y-px"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {status === "connected" && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Disconnect removes the local token. To fully revoke access, visit{" "}
          <button
            onClick={() => void openUrl(GITHUB_APPS_URL)}
            className="underline underline-offset-2 hover:text-foreground"
          >
            GitHub → Applications
          </button>
          .
        </p>
      )}

      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

/** Embedded terminal that runs an agent's CLI login flow in the user's home dir. */
function LoginTerminal({ sessionId, command }: { sessionId: string; command: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    void (async () => {
      const cwd = await homeDir().catch(() => "/");
      if (disposed) return;
      void spawnTerminal({
        chatId: sessionId,
        cwd,
        agentCmd: command,
        container,
        onExit: () => {},
      });
    })();
    return () => {
      disposed = true;
      disposeTerminal(sessionId);
    };
  }, [sessionId, command]);

  // Fit once the container has real dimensions.
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => fitTerminal(sessionId));
    return () => cancelAnimationFrame(raf);
  }, [sessionId]);

  return (
    <div className="mt-2 h-56 overflow-hidden rounded-lg border border-border bg-[#0d0e11]">
      <div ref={containerRef} className="h-full" />
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentProfile }) {
  const [open, setOpen] = useState(false);
  const setAgentDefaultModel = useAppStore((s) => s.setAgentDefaultModel);
  if (!agent.loginCommand && !agent.modelEnvVar) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{agent.name}</p>
          {agent.loginCommand && (
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {agent.loginCommand}
            </p>
          )}
        </div>
        {agent.loginCommand && (
          <button
            onClick={() => setOpen((v) => !v)}
            className={
              open
                ? "h-8 shrink-0 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition-all hover:text-foreground active:translate-y-px"
                : "h-8 shrink-0 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50"
            }
          >
            {open ? "Close" : "Run login"}
          </button>
        )}
      </div>
      {agent.modelEnvVar && (
        <label className="mt-2 block space-y-1 text-xs">
          <span className="text-muted-foreground">
            Default model for new chats (blank = agent default)
          </span>
          <input
            value={agent.defaultModel ?? ""}
            onChange={(e) => setAgentDefaultModel(agent.id, e.target.value)}
            placeholder="e.g. claude-opus-4-8"
            spellCheck={false}
            className={`${cloudInput} font-mono`}
          />
        </label>
      )}
      {open && agent.loginCommand && (
        <LoginTerminal
          sessionId={`login-${agent.id}`}
          command={agent.loginCommand}
        />
      )}
    </div>
  );
}

function AgentsSection() {
  const agents = useAppStore((s) => s.settings.agents);
  const configurable = agents.filter((a) => a.loginCommand || a.modelEnvVar);

  return (
    <div className="space-y-2">
      {configurable.map((agent) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
    </div>
  );
}

const cloudInput =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** Credentials and defaults for one-click cloud runs (the only editor now
 * that submission itself is a single click). */
function CloudSection() {
  const settings = useAppStore((s) => s.settings);
  const setCloudSettings = useAppStore((s) => s.setCloudSettings);
  const cloud = cloudSettingsOf(settings);
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [claudeInput, setClaudeInput] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [githubScope, setGithubScope] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void cloudSecretStatus()
      .then(setSecrets)
      .catch((e) => setError(String(e)));
  }, []);

  const saveSecret = async (name: string, value: string, clearInput: () => void) => {
    setError(null);
    try {
      setSecrets(await cloudSetSecret(name, value));
      clearInput();
    } catch (e) {
      setError(String(e));
    }
  };

  const githubSlot = githubScope.trim() ? `github_token:${githubScope.trim()}` : "github_token";
  const patch = (p: Partial<CloudSettings>) => setCloudSettings({ ...cloud, ...p });

  return (
    <div className="space-y-3 text-xs">
      <div className="rounded-xl border border-border bg-card p-3">
        <p className="mb-2 font-semibold uppercase tracking-wider text-[11px] text-muted-foreground">
          Credentials · Claude {secrets?.claude ? "✓" : "missing"} · GitHub {secrets?.github ? "✓" : "missing"}
        </p>
        <div className="space-y-2">
          <div className="flex gap-1.5">
            <input
              type="password"
              value={claudeInput}
              onChange={(e) => setClaudeInput(e.target.value)}
              placeholder={secrets?.claude ? "Claude OAuth token (stored) — paste to replace" : "Claude OAuth token from `claude setup-token`"}
              spellCheck={false}
              className={`${cloudInput} font-mono`}
            />
            <button
              onClick={() => void saveSecret("claude_oauth_token", claudeInput, () => setClaudeInput(""))}
              disabled={!claudeInput.trim() && !secrets?.claude}
              className="h-8 shrink-0 rounded-lg border border-border px-2 text-muted-foreground hover:text-foreground disabled:opacity-50"
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
              className={`${cloudInput} font-mono`}
            />
            <input
              value={githubScope}
              onChange={(e) => setGithubScope(e.target.value)}
              placeholder="owner or owner/repo (blank = any)"
              spellCheck={false}
              title={`Saves to Keychain slot ${githubSlot}; the most specific slot wins per remote.`}
              className={`${cloudInput} w-48 shrink-0 grow-0 font-mono`}
            />
            <button
              onClick={() => void saveSecret(githubSlot, githubInput, () => setGithubInput(""))}
              disabled={!githubInput.trim()}
              className="h-8 shrink-0 rounded-lg border border-border px-2 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Save
            </button>
          </div>
          <p className="text-muted-foreground">
            Kept in your macOS Keychain; sent to a task VM only for the duration of a run and shredded when it ends.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-3">
        <p className="mb-2 font-semibold uppercase tracking-wider text-[11px] text-muted-foreground">Run defaults</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-muted-foreground">Base snapshot</span>
            <input value={cloud.baseSnapshot} onChange={(e) => patch({ baseSnapshot: e.target.value })} spellCheck={false} className={`${cloudInput} font-mono`} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Deadline (minutes)</span>
            <input type="number" min={1} value={cloud.deadlineMinutes} onChange={(e) => patch({ deadlineMinutes: Number(e.target.value) || 1 })} className={cloudInput} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Permission mode</span>
            <select value={cloud.permissionMode} onChange={(e) => patch({ permissionMode: e.target.value })} className={cloudInput}>
              <option value="acceptEdits">acceptEdits</option>
              <option value="dontAsk">dontAsk</option>
              <option value="plan">plan</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Model (blank = default)</span>
            <input value={cloud.model} onChange={(e) => patch({ model: e.target.value })} spellCheck={false} className={`${cloudInput} font-mono`} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Max turns</span>
            <input
              type="number"
              min={1}
              value={cloud.maxTurns ?? ""}
              onChange={(e) => patch({ maxTurns: e.target.value === "" ? null : Number(e.target.value) })}
              placeholder="unlimited"
              className={cloudInput}
            />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Max budget (USD)</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={cloud.maxBudgetUsd ?? ""}
              onChange={(e) => patch({ maxBudgetUsd: e.target.value === "" ? null : Number(e.target.value) })}
              placeholder="unlimited"
              className={cloudInput}
            />
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-muted-foreground">Allowed tools (comma-separated)</span>
            <input value={cloud.allowedTools} onChange={(e) => patch({ allowedTools: e.target.value })} spellCheck={false} className={`${cloudInput} font-mono`} />
          </label>
        </div>
        <p className="mt-2 text-muted-foreground">
          Applied to every "Send to cloud" click. Per-repo env vars live in each repo's workflow settings.
        </p>
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

export function SettingsPage() {
  const open = useAppStore((s) => s.settingsOpen);
  const closeSettings = useAppStore((s) => s.closeSettings);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, closeSettings]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Draggable title strip (traffic-light overlay) with a close affordance. */}
      <div
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center justify-end px-3"
      >
        <button
          onClick={() => closeSettings()}
          title="Close settings"
          aria-label="Close settings"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-8 pb-16 pt-2">
          <h1 className="mb-6 text-lg font-semibold text-foreground">Settings</h1>

          <Section title="Account" description="Your Powerhouse identity.">
            <AccountSection />
          </Section>

          <Section title="Appearance" description="Choose your color theme.">
            <AppearanceSection />
          </Section>

          <Section
            title="Connections"
            description="Link external services to Powerhouse."
          >
            <ConnectionsSection />
          </Section>

          <Section
            title="Cloud"
            description="Credentials and defaults for one-click cloud runs."
          >
            <CloudSection />
          </Section>

          <Section
            title="Agents"
            description="CLI access and the default model for each coding agent."
          >
            <AgentsSection />
          </Section>
        </div>
      </div>
    </div>
  );
}
