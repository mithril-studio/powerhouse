import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MachinesPane } from "./MachinesPane";
import { PageHeader, Segmented } from "./ui/page";
import { TelemetryPage } from "./telemetry/TelemetryPage";
import { MemoryPage } from "./memory/MemoryPage";
import { getVersion } from "@tauri-apps/api/app";
import { homeDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  memorySettingsOf,
  useAppStore,
  type AgentProfile,
  type Theme,
} from "../store/appStore";
import { cloudSecretStatus, cloudSetSecret, runInShell, type SecretStatus } from "../lib/cloud";
import {
  DEFAULT_MEMORY_SETTINGS,
  memoryServerEnsure,
  type MemorySettings,
  type MemoryServerStatus,
} from "../lib/memory";
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

/** One settings row: label (and optional live status) left, controls right. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="ph-settings-section">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="ph-settings-stack">{children}</div>
    </section>
  );
}

/** Dot + word for a stored/missing value, used as a section's live status. */
function Status({ ok, yes, no }: { ok: boolean | undefined; yes: string; no: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`ph-dot ${ok ? "bg-current tone-running" : "ph-dot-ring text-muted-foreground/60"}`} aria-hidden />
      {ok ? yes : no}
    </span>
  );
}

/** Main → Account: the GitHub sign-in, with the app version as live status. */
function AccountSection() {
  const github = useAppStore((s) => s.settings.connections.github);
  const setGithubConnection = useAppStore((s) => s.setGithubConnection);
  const [version, setVersion] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Guards the async poll loop so Cancel / unmount stops it cleanly.
  const activeRef = useRef(false);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
    return () => {
      activeRef.current = false;
    };
  }, []);

  const { status } = github;
  const connected = status === "connected";

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

  return (
    <Section title="Account" description={version ? `Powerhouse v${version}` : undefined}>
      <div className="flex items-center gap-3">
        {connected && github.avatarUrl ? (
          <img src={github.avatarUrl} alt="" className="size-8 shrink-0 rounded-full object-cover" />
        ) : (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-semibold text-muted-foreground">
            {connected && github.login ? github.login[0].toUpperCase() : "P"}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-foreground">{connected && github.login ? `@${github.login}` : "Not signed in"}</p>
          <p className="ph-hint truncate">
            {connected ? "Signed in with GitHub" : status === "connecting" ? "Waiting for GitHub…" : "Sign in with your GitHub account"}
          </p>
        </div>
        {connected ? (
          <button type="button" onClick={() => void disconnect()} className="ph-btn">
            Disconnect
          </button>
        ) : status === "connecting" ? (
          <button type="button" onClick={finishDisconnected} className="ph-btn">
            Cancel
          </button>
        ) : (
          <button type="button" onClick={() => void connect()} className="ph-btn ph-btn-primary">
            Sign in with GitHub
          </button>
        )}
      </div>

      {status === "connecting" && device && (
        <div className="ph-list flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="ph-hint">
              Enter this code at{" "}
              <button type="button" onClick={() => void openUrl(device.verification_uri)}>
                {device.verification_uri.replace(/^https?:\/\//, "")}
              </button>
            </p>
            <code className="mt-1 block font-mono text-lg tracking-[0.3em] text-foreground">{device.user_code}</code>
          </div>
          <button type="button" onClick={() => void copyCode()} className="ph-btn">
            {copied ? "Copied" : "Copy code"}
          </button>
        </div>
      )}

      {connected && (
        <p className="ph-hint">
          Disconnect removes the local token. To fully revoke access, visit{" "}
          <button type="button" onClick={() => void openUrl(GITHUB_APPS_URL)}>
            GitHub → Applications
          </button>
          .
        </p>
      )}

      {error && <p className="ph-error">{error}</p>}
    </Section>
  );
}

function AppearanceSection() {
  const theme = useAppStore((s) => s.settings.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  return (
    <Section title="Appearance">
      <div>
        <Segmented<Theme>
          label="Color theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
        />
      </div>
    </Section>
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
    <div className="h-56 overflow-hidden rounded-[var(--radius)] border border-border bg-[#0d0e11] p-1">
      <div ref={containerRef} className="h-full" />
    </div>
  );
}

/** Agents → one row per agent: its CLI login and the default model. */
function AgentSection({ agent }: { agent: AgentProfile }) {
  const [open, setOpen] = useState(false);
  const setAgentDefaultModel = useAppStore((s) => s.setAgentDefaultModel);

  return (
    <Section title={agent.name}>
      {agent.loginCommand && (
        <div className="flex items-center gap-3">
          <p className="ph-hint min-w-0 flex-1">
            Sign in by running <code>{agent.loginCommand}</code> in a terminal here.
          </p>
          <button type="button" onClick={() => setOpen((v) => !v)} className="ph-btn">
            {open ? "Close terminal" : "Run login"}
          </button>
        </div>
      )}
      {open && agent.loginCommand && <LoginTerminal sessionId={`login-${agent.id}`} command={agent.loginCommand} />}
      {agent.modelEnvVar && (
        <label className="ph-field">
          Default model for new chats
          <input
            value={agent.defaultModel ?? ""}
            onChange={(e) => setAgentDefaultModel(agent.id, e.target.value)}
            placeholder="Agent default"
            spellCheck={false}
            className="ph-input h-8 font-mono"
          />
        </label>
      )}
    </Section>
  );
}

/** Memory → the switch and the Basic Memory server every session shares. */
function MemorySection() {
  const settings = useAppStore((s) => s.settings);
  const setMemorySettings = useAppStore((s) => s.setMemorySettings);
  const memory = memorySettingsOf(settings);
  const [status, setStatus] = useState<MemoryServerStatus | "checking" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<MemorySettings>) => setMemorySettings({ ...memory, ...p });

  const check = () => {
    setStatus("checking");
    setError(null);
    memoryServerEnsure(memory)
      .then(setStatus)
      .catch((e) => {
        setStatus("failed");
        setError(String(e));
      });
  };

  const statusText: Record<MemoryServerStatus | "checking", string> = {
    checking: "Checking…",
    external: "Connected",
    supervised: "Local server running, started by Powerhouse",
    unreachable: "Unreachable",
    failed: "Local server failed to start",
  };
  const healthy = status === "external" || status === "supervised";

  return (
    <>
      <Section title="Shared memory">
        <label className="ph-toggle">
          <input
            type="checkbox"
            className="ph-switch"
            checked={memory.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>
            Give every agent session the shared memory
            <span>
              Claude Code and Pi get the same Basic Memory server as an MCP tool, plus a brief of relevant notes on
              the first prompt. Their own memories are switched off so there is exactly one.
            </span>
          </span>
        </label>
      </Section>
      <Section title="Server">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,14rem)] gap-3">
          <label className="ph-field">
            MCP endpoint
            <input
              value={memory.url}
              onChange={(e) => patch({ url: e.target.value })}
              spellCheck={false}
              placeholder={DEFAULT_MEMORY_SETTINGS.url}
              className="ph-input h-8 font-mono"
            />
          </label>
          <label className="ph-field mt-0">
            Bearer token (remote host)
            <input
              type="password"
              value={memory.token}
              onChange={(e) => patch({ token: e.target.value })}
              className="ph-input h-8"
            />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={check} disabled={status === "checking"} className="ph-btn">
            Check connection
          </button>
          {status && (
            <span className={`inline-flex items-center gap-1.5 text-xs ${healthy || status === "checking" ? "text-muted-foreground" : "text-destructive"}`}>
              <span
                className={`ph-dot bg-current ${healthy ? "tone-running" : status === "checking" ? "animate-pulse" : ""}`}
                aria-hidden
              />
              {statusText[status]}
            </span>
          )}
        </div>
        {error && <p className="ph-error">{error}</p>}
        <p className="ph-hint">
          Powerhouse starts a loopback endpoint itself (needs <code>basic-memory</code> on your PATH:{" "}
          <code>uv tool install basic-memory</code>). Point it at the memory VM to share one memory across machines.
          Notes live in <code>~/.powerhouse/memory</code>.
        </p>
      </Section>
    </>
  );
}

/** Credentials for cloud chats. Everything else is inherited from the chat
 * (agent, model) and the repo (env vars). */
function CloudSection() {
  const branchId = useAppStore((s) => s.selection.branchId);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [claudeInput, setClaudeInput] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [githubScope, setGithubScope] = useState("");
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);

  useEffect(() => {
    void cloudSecretStatus()
      .then(setSecrets)
      .catch((e) => setClaudeError(String(e)));
  }, []);

  const saveSecret = async (
    name: string,
    value: string,
    clearInput: () => void,
    setError: (e: string | null) => void,
  ) => {
    setError(null);
    try {
      setSecrets(await cloudSetSecret(name, value));
      clearInput();
    } catch (e) {
      setError(String(e));
    }
  };

  const githubSlot = githubScope.trim() ? `github_token:${githubScope.trim()}` : "github_token";

  return (
    <>
      <Section title="Claude token" description={<Status ok={secrets?.claude} yes="Stored in Keychain" no="Not set" />}>
        <div className="flex gap-2">
          <input
            type="password"
            value={claudeInput}
            onChange={(e) => setClaudeInput(e.target.value)}
            placeholder={secrets?.claude ? "Paste a new token to replace it" : "OAuth token from claude setup-token"}
            aria-label="Claude OAuth token"
            spellCheck={false}
            className="ph-input h-8 min-w-0 flex-1 font-mono"
          />
          <button
            type="button"
            onClick={() =>
              void saveSecret("claude_oauth_token", claudeInput, () => setClaudeInput(""), setClaudeError)
            }
            disabled={!claudeInput.trim() && !secrets?.claude}
            className="ph-btn"
          >
            {claudeInput.trim() || !secrets?.claude ? "Save" : "Clear"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!branchId) return;
              closeSettings();
              runInShell(branchId, "claude setup-token");
            }}
            disabled={!branchId}
            title={
              branchId
                ? "Runs `claude setup-token` in this branch's shell. Paste the token it prints here."
                : "Select a branch first; the command runs in its shell."
            }
            className="ph-btn"
          >
            Get token
          </button>
        </div>
        {!secrets?.claude && (
          <p className="ph-hint">
            Get token runs <code>claude setup-token</code> in the bottom shell; paste the token it prints above.
          </p>
        )}
        {claudeError && <p className="ph-error">{claudeError}</p>}
      </Section>

      <Section title="GitHub token" description={<Status ok={secrets?.github} yes="Stored in Keychain" no="Not set" />}>
        <input
          type="password"
          value={githubInput}
          onChange={(e) => setGithubInput(e.target.value)}
          placeholder="Fine-grained token with Contents: read & write"
          aria-label="GitHub token"
          spellCheck={false}
          className="ph-input h-8 font-mono"
        />
        <div className="flex gap-2">
          <input
            value={githubScope}
            onChange={(e) => setGithubScope(e.target.value)}
            placeholder="owner or owner/repo (blank = any)"
            aria-label="Repos this token is for"
            spellCheck={false}
            title={`Saves to Keychain slot ${githubSlot}; the most specific slot wins per remote.`}
            className="ph-input h-8 min-w-0 flex-1 font-mono"
          />
          <button
            type="button"
            onClick={() => void saveSecret(githubSlot, githubInput, () => setGithubInput(""), setGithubError)}
            disabled={!githubInput.trim()}
            className="ph-btn"
          >
            Save
          </button>
        </div>
        {githubError && <p className="ph-error">{githubError}</p>}
        <p className="ph-hint">
          Written to each cloud machine's <code>~/.ph/env</code>, outside the repo. Cloud chats never use your GitHub
          sign-in, and their agents run without permission prompts, so give this token only the repos Powerhouse may
          push to.
        </p>
      </Section>
    </>
  );
}

function AgentsTab() {
  const agents = useAppStore((s) => s.settings.agents);
  const configurable = agents.filter((a) => a.loginCommand || a.modelEnvVar);
  if (configurable.length === 0) return <p className="ph-hint py-6">No agent needs a login or a default model.</p>;
  return (
    <>
      {configurable.map((agent) => (
        <AgentSection key={agent.id} agent={agent} />
      ))}
    </>
  );
}

const TABS = ["Main", "Agents", "Memory", "Cloud", "Telemetry"] as const;
type Tab = (typeof TABS)[number];

export function SettingsPage() {
  const open = useAppStore((s) => s.settingsOpen);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const [tab, setTab] = useState<Tab>("Main");

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
    <div className="fixed inset-y-0 right-0 left-60 z-40 flex flex-col border-l border-border bg-background">
      {/* Draggable title strip (traffic-light overlay). The sidebar Settings
          toggle opens and closes this panel, so there is no close button here. */}
      <div data-tauri-drag-region className="h-11 shrink-0 px-3" />

      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto w-full px-8 pb-16 pt-2 ${tab === "Telemetry" || tab === "Memory" ? "max-w-6xl" : "max-w-4xl"}`}>
          <PageHeader title="Settings" className="mx-0 pt-0">
            <Segmented
              label="Settings section"
              value={tab}
              onChange={setTab}
              options={TABS.map((t) => ({ value: t, label: t }))}
            />
          </PageHeader>

          {tab === "Main" ? (
            <>
              <AccountSection />
              <AppearanceSection />
            </>
          ) : tab === "Agents" ? (
            <AgentsTab />
          ) : tab === "Memory" ? (
            <MemorySection />
          ) : tab === "Cloud" ? (
            <>
              <CloudSection />
              <Section
                title="Machines"
                description="Every boxd VM on your account. Chats create and retire their own; stop or delete leftovers here."
              >
                <MachinesPane />
              </Section>
            </>
          ) : (
            <TelemetryPage embedded />
          )}
          {tab === "Memory" && <MemoryPage embedded />}
        </div>
      </div>
    </div>
  );
}
