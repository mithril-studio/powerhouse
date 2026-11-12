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
  type SettingsSection,
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

import { TelemetryPage } from "./telemetry/TelemetryPage";

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
    <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,12rem)_1fr] gap-6 border-t border-border py-6 first:border-t-0 first:pt-0">
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
    <div className="grid max-w-md grid-cols-2 gap-3" role="group" aria-label="Color theme">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          aria-pressed={theme === opt.value}
          className={`rounded-xl border p-2 text-left transition-colors ${theme === opt.value ? "border-primary ring-1 ring-primary" : "border-border hover:border-input"}`}
        >
          <div aria-hidden="true" className={`flex h-24 overflow-hidden rounded-md border ${opt.value === "dark" ? "border-[#191919] bg-black" : "border-[#e4e4e7] bg-[#fcfcfc]"}`}>
            <div className={`w-1/3 space-y-2 border-r p-2 ${opt.value === "dark" ? "border-[#191919]" : "border-[#e4e4e7] bg-[#fafafa]"}`}>
              <div className={`h-1.5 w-3/4 rounded-full ${opt.value === "dark" ? "bg-[#a3a3a3]" : "bg-[#71717b]"}`} />
              <div className={`h-3 rounded-sm ${opt.value === "dark" ? "bg-[#1a1b1b]" : "bg-[#e4e4e7]"}`} />
              <div className={`h-1.5 w-2/3 rounded-full ${opt.value === "dark" ? "bg-[#333333]" : "bg-[#d4d4d8]"}`} />
            </div>
            <div className="flex flex-1 flex-col justify-end p-2">
              <div className={`h-6 rounded-md border ${opt.value === "dark" ? "border-[#2e2e2e] bg-[#111111]" : "border-[#d4d4d8] bg-white"}`} />
            </div>
          </div>
          <span className="mt-2 flex items-center justify-between px-1 text-xs font-medium">
            {opt.label}
            {theme === opt.value && <span aria-hidden="true" className="text-primary">✓</span>}
          </span>
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
  if (!agent.loginCommand) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{agent.name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {agent.loginCommand}
          </p>
        </div>
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
      </div>
      {open && (
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
  const withLogin = agents.filter((a) => a.loginCommand);

  return (
    <div className="space-y-2">
      {withLogin.map((agent) => (
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

const SETTINGS_SECTIONS: { id: SettingsSection; label: string; description: string }[] = [
  { id: "general", label: "General", description: "Your Powerhouse account and workspace." },
  { id: "appearance", label: "Appearance", description: "Make Powerhouse feel like home." },
  { id: "connections", label: "Connections", description: "Connect the services you work with." },
  { id: "cloud", label: "Cloud", description: "Credentials and defaults for cloud runs." },
  { id: "agents", label: "Agents", description: "Manage your coding agents and CLI access." },
  { id: "memory", label: "Memory", description: "Context and learnings across your projects." },
  { id: "telemetry", label: "Telemetry", description: "Understand what your agents are doing." },
];

function MemorySection() {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h2 className="text-sm font-medium">Project memory</h2>
      <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
        Memory management isn't available in Powerhouse yet. Your agents continue
        to use the instructions and memory files in each project.
      </p>
    </div>
  );
}

export function SettingsPage() {
  const open = useAppStore((s) => s.settingsOpen);
  const section = useAppStore((s) => s.settingsSection);
  const openSettings = useAppStore((s) => s.openSettings);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const navRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    navRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeSettings();
      } else if (e.key === "Tab") {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
        ) ?? []).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      previousFocus?.focus();
    };
  }, [open, closeSettings]);

  if (!open) return null;
  const current = SETTINGS_SECTIONS.find((item) => item.id === section)!;

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Settings" className="fixed inset-0 z-50 flex bg-background">
      <aside className="flex w-48 shrink-0 flex-col border-r border-sidebar-border bg-sidebar sm:w-60">
        <div data-tauri-drag-region className="h-11 shrink-0" />
        <div className="px-3 pb-4">
          <button onClick={() => closeSettings()} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
            <span aria-hidden="true">←</span> Back to workspace
          </button>
        </div>
        <h1 className="px-5 pb-3 text-sm font-semibold">Settings</h1>
        <nav ref={navRef} aria-label="Settings sections" className="flex flex-col gap-1 px-3">
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              onClick={() => openSettings(item.id)}
              aria-current={section === item.id ? "page" : undefined}
              className={`flex h-9 items-center rounded-md px-3 text-left text-sm transition-colors ${section === item.id ? "bg-sidebar-selected text-foreground font-medium" : "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"}`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <p className="mt-auto px-5 py-4 text-xs text-muted-foreground">Powerhouse</p>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div data-tauri-drag-region className="flex h-11 shrink-0 items-center justify-end border-b border-border px-3">
          <button onClick={() => closeSettings()} title="Close settings (Esc)" aria-label="Close settings" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">✕</button>
        </div>
        <div key={section} className="flex-1 overflow-y-auto">
          <div className={`mx-auto w-full px-6 py-8 lg:px-10 ${section === "telemetry" ? "max-w-6xl" : "max-w-3xl"}`}>
            <header className="mb-8">
              <h2 className="text-xl font-semibold tracking-tight">{current.label}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{current.description}</p>
            </header>
            {section === "general" && <AccountSection />}
            {section === "appearance" && <Section title="Color theme" description="T3's neutral palette, in light or dark."><AppearanceSection /></Section>}
            {section === "connections" && <ConnectionsSection />}
            {section === "cloud" && <CloudSection />}
            {section === "agents" && <AgentsSection />}
            {section === "memory" && <MemorySection />}
            {section === "telemetry" && <TelemetryPage />}
          </div>
        </div>
      </div>
    </div>
  );
}
