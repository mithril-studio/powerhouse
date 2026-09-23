import { create } from "zustand";
import type { AcpTranscriptItem } from "../lib/acpTranscript";

export type AgentTransport = "acp" | "pty";

/** Which surface the persistent bottom panel is showing. */
export type BottomTab = "shell" | "agent";

/**
 * How completely a native-CLI handoff shares state with the ACP session:
 * - `unsupported`: no native CLI handoff is offered.
 * - `workspace-only`: the CLI opens in the same worktree but is a separate
 *   conversation — never claim shared context.
 * - `resumable`: the same native session can be resumed across surfaces
 *   (only after real round-trip resume is verified for that runtime).
 */
export type HandoffMode = "unsupported" | "workspace-only" | "resumable";
import type { CloudRunRecord } from "../lib/cloud";

export interface Chat {
  id: string;
  title: string;
  /** Absent = use the default agent. */
  agentId?: string;
  /** When set, the agent is launched via its promptTemplate instead of bare command. */
  initialPrompt?: string;
  /**
   * Present once the chat has launched a resumable agent session; value is the
   * id passed to the agent's `--session-id` (initially `chat.id`). Its presence
   * marks the chat as resumable.
   */
  agentSessionId?: string;
  /** Per-chat escape hatch; otherwise the selected agent's transport is used. */
  transport?: AgentTransport;
  /** Structured ACP history. PTY chats continue to use raw transcript files. */
  acpTranscript?: AcpTranscriptItem[];
}

export interface AgentProfile {
  id: string;
  name: string;
  command: string; // e.g. "claude"
  promptTemplate: string; // e.g. 'claude "{prompt}"'
  /** Fresh start pinning a session id, e.g. "claude --session-id {sessionId}". */
  startTemplate?: string;
  /** Fresh start pinning a session id + initial prompt. */
  startPromptTemplate?: string;
  /** Resume an existing session, e.g. "claude --resume {sessionId}". */
  resumeTemplate?: string;
  /** Defaults to PTY for custom/legacy profiles. */
  transport?: AgentTransport;
  /** Stdio ACP server command used when transport is `acp`. */
  acpCommand?: string;
  /** How the native CLI (opened alongside ACP) relates to the ACP session. */
  handoff?: HandoffMode;
  /** Shell command that runs the agent's CLI auth flow, e.g. "codex login". */
  loginCommand?: string;
}

export type Theme = "dark" | "light";

export type GithubStatus = "disconnected" | "connecting" | "connected";

/** GitHub OAuth state. The access token is NEVER kept here (it lives in the OS
 *  keychain, Rust-side); only the non-sensitive display profile is persisted. */
export interface GithubConnection {
  status: GithubStatus;
  login?: string;
  avatarUrl?: string;
}

/** Third-party service connections. */
export interface Connections {
  github: GithubConnection;
}

/** Defaults for the `Run in cloud` form. Additive; older stores lack it. */
export interface CloudSettings {
  /** boxd snapshot every task VM is created from (published by scripts/cloud-base-setup.sh). */
  baseSnapshot: string;
  /** Org-wide machine count at which Powerhouse refuses to create another VM (org limit 20). */
  machineCeiling: number;
  deadlineMinutes: number;
  permissionMode: string;
  allowedTools: string;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  model: string;
}

export const DEFAULT_CLOUD_SETTINGS: CloudSettings = {
  baseSnapshot: "powerhouse-base",
  machineCeiling: 18,
  deadlineMinutes: 45,
  permissionMode: "acceptEdits",
  allowedTools: "Read,Edit,Write,Glob,Grep,Bash",
  maxTurns: 60,
  maxBudgetUsd: 5,
  model: "",
};

export interface Settings {
  agents: AgentProfile[];
  defaultAgentId: string;
  theme: Theme;
  connections: Connections;
  cloud?: CloudSettings;
}

export interface Branch {
  id: string;
  name: string;
  worktreePath: string;
  chats: Chat[];
  activeChatId: string | null;
  /** Set true once this branch lands on main via the queue (green dot). */
  merged?: boolean;
}

/** Tabs of the toggleable right inspector sidebar. */
export type RightTab = "files" | "changes" | "diff" | "merge" | "cloud";

/** A configurable check step. `type` is reserved for future "agent" steps. */
export interface WorkflowStep {
  id: string;
  name: string;
  command: string;
  type: "command";
}

/** Serialized from Rust — snake_case field names are intentional. */
export interface StepState {
  name: string;
  command: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  exit_code: number | null;
  duration_ms: number | null;
}

export type QueueState =
  | "queued"
  | "validating"
  | "merging"
  | "merged"
  | "failed"
  | "canceled"
  | "interrupted";

/** Serialized from Rust — snake_case field names are intentional. */
export interface QueueEntry {
  id: string;
  repo_id: string;
  branch: string;
  state: QueueState;
  steps: StepState[];
  error: string | null;
  merge_commit: string | null;
  created_at: number;
  finished_at: number | null;
}

const LIVE_QUEUE_STATES: QueueState[] = ["queued", "validating", "merging"];
const QUEUE_HISTORY_CAP = 50;

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  branches: Branch[];
  workflow: WorkflowStep[];
  pushOnMerge: boolean;
  /** Env var names injected into this repo's cloud runs; values live in the Keychain. */
  cloudEnvNames?: string[];
}

export interface Selection {
  repoId: string | null;
  branchId: string | null;
}

/** A recently-opened project, shown in the Add-project menu's Recents list. */
export interface RecentRepo {
  name: string;
  path: string;
  defaultBranch: string;
}

const RECENTS_CAP = 8;

/** Runtime-only; terminals/PTYs are never persisted. */
export type ChatStatus = "idle" | "running" | "exited";

export interface PersistedTree {
  repos: Repo[];
  selection: Selection;
  settings: Settings;
  queues: Record<string, QueueEntry[]>;
  /** MRU of opened projects, for the Add-project menu's Recents. */
  recentRepos: RecentRepo[];
}

/** Prepend a project to the MRU, dedupe by path, cap the length. */
function pushRecent(list: RecentRepo[], r: RecentRepo): RecentRepo[] {
  return [r, ...list.filter((x) => x.path !== r.path)].slice(0, RECENTS_CAP);
}

/** Old persisted shape (pre agent-profiles) — read only during migration. */
interface LegacyTree {
  agentCmd?: string;
}

interface AppState extends PersistedTree {
  hydrated: boolean;
  chatStatus: Record<string, ChatStatus>;
  branchModalRepoId: string | null;
  workflowModalRepoId: string | null;
  rightSidebarOpen: boolean;
  rightTab: RightTab;
  chatPickerOpen: boolean;
  bottomPanelOpen: boolean;
  bottomTab: BottomTab;
  shellStatus: Record<string, ChatStatus>;
  /** branchId → setTimeout id of the in-flight handoff (presence = pending). */
  pendingHandoff: Record<string, number>;
  /** Runtime mirror of the Rust-owned cloud-run store (never persisted here). */
  cloudRuns: Record<string, CloudRunRecord>;
  /** `${repoId}:${branch}` → stage of an in-flight one-click submit (never persisted). */
  cloudQuickStages: Record<string, string>;
  /** `${repoId}:${branch}` → why the last send to cloud stopped, until dismissed. */
  cloudQuickErrors: Record<string, string>;

  settingsOpen: boolean;
  telemetryOpen: boolean;

  hydrate: (tree: (Partial<PersistedTree> & LegacyTree) | null) => void;
  setDefaultAgent: (agentId: string) => void;
  setTheme: (theme: Theme) => void;
  setGithubConnection: (github: GithubConnection) => void;
  openSettings: () => void;
  closeSettings: () => void;
  openTelemetry: () => void;
  closeTelemetry: () => void;
  addRepo: (repo: Omit<Repo, "id" | "branches" | "workflow" | "pushOnMerge">) => Repo;
  removeRecentRepo: (path: string) => void;
  addBranch: (repoId: string, branch: Branch) => void;
  removeBranch: (repoId: string, branchId: string) => void;
  addChat: (repoId: string, branchId: string, chat: Chat) => void;
  removeChat: (repoId: string, branchId: string, chatId: string) => void;
  setActiveChat: (repoId: string, branchId: string, chatId: string) => void;
  setChatAgentSession: (
    repoId: string,
    branchId: string,
    chatId: string,
    sessionId: string,
  ) => void;
  setChatTransport: (
    repoId: string,
    branchId: string,
    chatId: string,
    transport: AgentTransport,
  ) => void;
  updateChatAcpTranscript: (
    repoId: string,
    branchId: string,
    chatId: string,
    update: (transcript: AcpTranscriptItem[]) => AcpTranscriptItem[],
  ) => void;
  select: (repoId: string | null, branchId: string | null) => void;
  setChatStatus: (chatId: string, status: ChatStatus) => void;
  openBranchModal: (repoId: string) => void;
  closeBranchModal: () => void;

  setQueueEntries: (repoId: string, live: QueueEntry[]) => void;
  dismissQueueEntry: (repoId: string, entryId: string) => void;
  setWorkflow: (repoId: string, workflow: WorkflowStep[], pushOnMerge: boolean) => void;
  setRepoEnvNames: (repoId: string, names: string[]) => void;
  openWorkflowModal: (repoId: string) => void;
  closeWorkflowModal: () => void;
  toggleRightSidebar: () => void;
  setRightTab: (tab: RightTab) => void;
  openRightTab: (tab: RightTab) => void;

  openChatPicker: () => void;
  closeChatPicker: () => void;
  toggleBottomPanel: () => void;
  setBottomTab: (tab: BottomTab) => void;
  openBottomPanel: (tab: BottomTab) => void;
  setShellStatus: (branchId: string, status: ChatStatus) => void;
  setPendingHandoff: (branchId: string, timerId: number) => void;
  clearPendingHandoff: (branchId: string) => void;

  setCloudRuns: (runs: CloudRunRecord[]) => void;
  setCloudRun: (run: CloudRunRecord) => void;
  removeCloudRun: (runId: string) => void;
  setCloudSettings: (cloud: CloudSettings) => void;
  setCloudQuickStage: (repoId: string, branch: string, stage: string | null) => void;
  setCloudQuickError: (repoId: string, branch: string, reason: string | null) => void;
}

const SEED_AGENTS: AgentProfile[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    promptTemplate: 'claude "{prompt}"',
    startTemplate: "claude --session-id {sessionId}",
    startPromptTemplate: 'claude --session-id {sessionId} "{prompt}"',
    resumeTemplate: "claude --resume {sessionId}",
    transport: "acp",
    acpCommand: "npx -y @agentclientprotocol/claude-agent-acp",
    // Round-trip resume between ACP and the CLI is unverified; only share the
    // worktree until it is.
    handoff: "workspace-only",
    // Bare `claude` runs the auth flow when unauthenticated; use /login inside otherwise.
    loginCommand: "claude",
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    promptTemplate: 'codex "{prompt}"',
    transport: "acp",
    acpCommand: "npx -y @agentclientprotocol/codex-acp",
    handoff: "workspace-only",
    loginCommand: "codex login",
  },
  {
    id: "pi",
    name: "Pi",
    command: "pi",
    promptTemplate: 'pi "{prompt}"',
    transport: "acp",
    acpCommand: "npx -y pi-acp",
    handoff: "workspace-only",
  },
];

const seedSettings = (): Settings => ({
  agents: SEED_AGENTS.map((a) => ({ ...a })),
  defaultAgentId: "claude",
  theme: "dark",
  connections: { github: { status: "disconnected" } },
});

/** Backfills resume templates onto known seed agents that predate them, leaving
 *  custom agents and any user-edited fields untouched. */
function backfillAgentProfiles(agents: AgentProfile[]): AgentProfile[] {
  const seedById = Object.fromEntries(SEED_AGENTS.map((a) => [a.id, a]));
  const backfilled = agents.filter((a) => a.id !== "opencode").map((a) => {
    const seed = seedById[a.id];
    if (!seed) return a;
    return {
      ...a,
      startTemplate: a.startTemplate ?? seed.startTemplate,
      startPromptTemplate: a.startPromptTemplate ?? seed.startPromptTemplate,
      resumeTemplate: a.resumeTemplate ?? seed.resumeTemplate,
      transport: a.transport ?? seed.transport,
      acpCommand: a.acpCommand ?? seed.acpCommand,
      handoff: a.handoff ?? seed.handoff,
      loginCommand: a.loginCommand ?? seed.loginCommand,
    };
  });
  const existing = new Set(backfilled.map((agent) => agent.id));
  return [
    ...backfilled,
    ...SEED_AGENTS.filter((agent) => !existing.has(agent.id)).map((agent) => ({
      ...agent,
    })),
  ];
}

/** Normalizes the persisted GitHub connection. The pre-OAuth stub stored a bare
 *  boolean; migrate it (and any stale "connecting") to "disconnected" — the
 *  keychain is the source of truth and is reconciled at boot. */
function migrateGithub(raw: unknown): GithubConnection {
  if (raw && typeof raw === "object") {
    const g = raw as Partial<GithubConnection>;
    if (g.status === "connected") {
      return { status: "connected", login: g.login, avatarUrl: g.avatarUrl };
    }
  }
  return { status: "disconnected" };
}

/** Migrates the old `agentCmd` string into agent profiles, or passes settings through. */
export function migrateSettings(
  tree: (Partial<PersistedTree> & LegacyTree) | null,
): Settings {
  const theme: Theme = tree?.settings?.theme === "light" ? "light" : "dark";
  const connections: Connections = {
    github: migrateGithub(tree?.settings?.connections?.github),
  };

  if (tree?.settings && tree.settings.agents?.length) {
    const { defaultAgentId } = tree.settings;
    const agents = backfillAgentProfiles(tree.settings.agents);
    const validDefault = agents.some((a) => a.id === defaultAgentId);
    return {
      agents,
      defaultAgentId: validDefault ? defaultAgentId : agents[0].id,
      theme,
      connections,
      ...(tree.settings.cloud ? { cloud: { ...DEFAULT_CLOUD_SETTINGS, ...tree.settings.cloud } } : {}),
    };
  }
  const agents = SEED_AGENTS.map((a) => ({ ...a }));
  const legacy = tree?.agentCmd?.trim();
  if (legacy) {
    const match = agents.find((a) => a.command === legacy);
    if (match) return { agents, defaultAgentId: match.id, theme, connections };
    const custom: AgentProfile = {
      id: crypto.randomUUID(),
      name: legacy,
      command: legacy,
      promptTemplate: `${legacy} "{prompt}"`,
    };
    return { agents: [custom, ...agents], defaultAgentId: custom.id, theme, connections };
  }
  return { agents, defaultAgentId: "claude", theme, connections };
}

/** Resolves the profile for a chat, falling back to the default agent. */
export const resolveAgent = (settings: Settings, agentId?: string): AgentProfile =>
  settings.agents.find((a) => a.id === agentId) ??
  settings.agents.find((a) => a.id === settings.defaultAgentId) ??
  settings.agents[0];

export const resolveChatTransport = (
  settings: Settings,
  chat: Pick<Chat, "agentId" | "transport">,
): AgentTransport => chat.transport ?? resolveAgent(settings, chat.agentId).transport ?? "pty";

/** Native-CLI handoff capability for an agent, defaulting conservatively. */
export const resolveHandoff = (profile: AgentProfile): HandoffMode =>
  profile.handoff ??
  (profile.transport === "acp" && profile.command ? "workspace-only" : "unsupported");

export const renderTemplate = (profile: AgentProfile, prompt: string): string =>
  profile.promptTemplate.replace(/\{prompt\}/g, prompt);

/** True when the agent supports pinning a session id and resuming it. */
export const isSessionCapable = (profile: AgentProfile): boolean =>
  !!(profile.startTemplate && profile.resumeTemplate);

/** Fresh start pinning a deterministic session id (optionally with a prompt).
 *  Falls back to the plain command/promptTemplate for non-session agents. */
export const renderStart = (
  profile: AgentProfile,
  sessionId: string,
  prompt?: string,
): string => {
  const tpl = prompt ? profile.startPromptTemplate : profile.startTemplate;
  if (!tpl) return prompt ? renderTemplate(profile, prompt) : profile.command;
  return tpl.replace(/\{sessionId\}/g, sessionId).replace(/\{prompt\}/g, prompt ?? "");
};

/** Resumes an existing agent session by id, or null if unsupported. */
export const renderResume = (profile: AgentProfile, sessionId: string): string | null =>
  profile.resumeTemplate
    ? profile.resumeTemplate.replace(/\{sessionId\}/g, sessionId)
    : null;

const updateRepo = (repos: Repo[], repoId: string, fn: (r: Repo) => Repo) =>
  repos.map((r) => (r.id === repoId ? fn(r) : r));

const updateBranch = (
  repos: Repo[],
  repoId: string,
  branchId: string,
  fn: (b: Branch) => Branch,
) =>
  updateRepo(repos, repoId, (r) => ({
    ...r,
    branches: r.branches.map((b) => (b.id === branchId ? fn(b) : b)),
  }));

export const useAppStore = create<AppState>((set, get) => ({
  repos: [],
  recentRepos: [],
  selection: { repoId: null, branchId: null },
  settings: seedSettings(),
  queues: {},
  hydrated: false,
  chatStatus: {},
  branchModalRepoId: null,
  workflowModalRepoId: null,
  rightSidebarOpen: false,
  rightTab: "changes",
  chatPickerOpen: false,
  bottomPanelOpen: false,
  bottomTab: "shell",
  shellStatus: {},
  pendingHandoff: {},
  settingsOpen: false,
  telemetryOpen: false,
  cloudRuns: {},
  cloudQuickStages: {},
  cloudQuickErrors: {},

  hydrate: (tree) =>
    set({
      // Migration: default the queue-config fields for repos persisted before
      // they existed.
      repos: (tree?.repos ?? []).map((r) => ({
        ...r,
        workflow: r.workflow ?? [],
        pushOnMerge: r.pushOnMerge ?? true,
      })),
      selection: tree?.selection ?? { repoId: null, branchId: null },
      recentRepos: tree?.recentRepos ?? [],
      settings: migrateSettings(tree),
      // The Rust engine starts empty, so any entry persisted in a live state
      // was cut short by a crash/quit — surface it as `interrupted`.
      queues: Object.fromEntries(
        Object.entries(tree?.queues ?? {}).map(([repoId, entries]) => [
          repoId,
          entries.map((e) =>
            LIVE_QUEUE_STATES.includes(e.state)
              ? { ...e, state: "interrupted" as const }
              : e,
          ),
        ]),
      ),
      hydrated: true,
    }),

  setDefaultAgent: (agentId) =>
    set((s) =>
      s.settings.agents.some((a) => a.id === agentId)
        ? { settings: { ...s.settings, defaultAgentId: agentId } }
        : s,
    ),

  setTheme: (theme) => set((s) => ({ settings: { ...s.settings, theme } })),

  setGithubConnection: (github) =>
    set((s) => ({
      settings: {
        ...s.settings,
        connections: { ...s.settings.connections, github },
      },
    })),

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  openTelemetry: () => set({ telemetryOpen: true }),
  closeTelemetry: () => set({ telemetryOpen: false }),

  addRepo: (repo) => {
    const recent: RecentRepo = {
      name: repo.name,
      path: repo.path,
      defaultBranch: repo.defaultBranch,
    };
    const existing = get().repos.find((r) => r.path === repo.path);
    if (existing) {
      set((s) => ({
        selection: { repoId: existing.id, branchId: null },
        recentRepos: pushRecent(s.recentRepos, recent),
      }));
      return existing;
    }
    const created: Repo = {
      ...repo,
      id: crypto.randomUUID(),
      branches: [],
      workflow: [],
      pushOnMerge: true,
    };
    set((s) => ({
      repos: [...s.repos, created],
      selection: { repoId: created.id, branchId: null },
      recentRepos: pushRecent(s.recentRepos, recent),
    }));
    return created;
  },

  removeRecentRepo: (path) =>
    set((s) => ({ recentRepos: s.recentRepos.filter((r) => r.path !== path) })),

  addBranch: (repoId, branch) =>
    set((s) => ({
      repos: updateRepo(s.repos, repoId, (r) => ({
        ...r,
        branches: [...r.branches, branch],
      })),
      selection: { repoId, branchId: branch.id },
    })),

  removeBranch: (repoId, branchId) =>
    set((s) => ({
      repos: updateRepo(s.repos, repoId, (r) => ({
        ...r,
        branches: r.branches.filter((b) => b.id !== branchId),
      })),
      selection:
        s.selection.branchId === branchId
          ? { repoId, branchId: null }
          : s.selection,
    })),

  addChat: (repoId, branchId, chat) =>
    set((s) => ({
      repos: updateBranch(s.repos, repoId, branchId, (b) => ({
        ...b,
        chats: [...b.chats, chat],
        activeChatId: chat.id,
      })),
    })),

  removeChat: (repoId, branchId, chatId) =>
    set((s) => ({
      repos: updateBranch(s.repos, repoId, branchId, (b) => {
        const chats = b.chats.filter((c) => c.id !== chatId);
        let activeChatId = b.activeChatId;
        if (activeChatId === chatId) {
          const idx = b.chats.findIndex((c) => c.id === chatId);
          activeChatId = chats[Math.min(idx, chats.length - 1)]?.id ?? null;
        }
        return { ...b, chats, activeChatId };
      }),
    })),

  setActiveChat: (repoId, branchId, chatId) =>
    set((s) => ({
      repos: updateBranch(s.repos, repoId, branchId, (b) => ({
        ...b,
        activeChatId: chatId,
      })),
    })),

  setChatAgentSession: (repoId, branchId, chatId, sessionId) =>
    set((s) => ({
      repos: updateBranch(s.repos, repoId, branchId, (b) => ({
        ...b,
        chats: b.chats.map((c) =>
          c.id === chatId ? { ...c, agentSessionId: sessionId } : c,
        ),
      })),
    })),

  setChatTransport: (repoId, branchId, chatId, transport) =>
    set((s) => ({
      repos: updateBranch(s.repos, repoId, branchId, (b) => ({
        ...b,
        chats: b.chats.map((c) => (c.id === chatId ? { ...c, transport } : c)),
      })),
    })),

  updateChatAcpTranscript: (repoId, branchId, chatId, update) =>
    set((s) => ({
      repos: updateBranch(s.repos, repoId, branchId, (b) => ({
        ...b,
        chats: b.chats.map((c) =>
          c.id === chatId
            ? { ...c, acpTranscript: update(c.acpTranscript ?? []) }
            : c,
        ),
      })),
    })),

  // Selecting a project/branch is a navigation — it also leaves the telemetry
  // and settings pages (which otherwise cover the main area).
  select: (repoId, branchId) =>
    set({ selection: { repoId, branchId }, telemetryOpen: false, settingsOpen: false }),

  setChatStatus: (chatId, status) =>
    set((s) => ({ chatStatus: { ...s.chatStatus, [chatId]: status } })),

  openBranchModal: (repoId) => set({ branchModalRepoId: repoId }),
  closeBranchModal: () => set({ branchModalRepoId: null }),

  // Merge the engine's live snapshot over persisted history: snapshot entries
  // win by id, older terminal entries are kept, newest 50 retained.
  setQueueEntries: (repoId, live) =>
    set((s) => {
      const liveIds = new Set(live.map((e) => e.id));
      const history = (s.queues[repoId] ?? []).filter((e) => !liveIds.has(e.id));
      const merged = [...live, ...history]
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, QUEUE_HISTORY_CAP);

      const mergedBranches = new Set(
        merged.filter((e) => e.state === "merged").map((e) => e.branch),
      );
      const repos = mergedBranches.size
        ? updateRepo(s.repos, repoId, (r) => ({
            ...r,
            branches: r.branches.map((b) =>
              mergedBranches.has(b.name) && !b.merged ? { ...b, merged: true } : b,
            ),
          }))
        : s.repos;

      return { queues: { ...s.queues, [repoId]: merged }, repos };
    }),

  dismissQueueEntry: (repoId, entryId) =>
    set((s) => ({
      queues: {
        ...s.queues,
        [repoId]: (s.queues[repoId] ?? []).filter((e) => e.id !== entryId),
      },
    })),

  setWorkflow: (repoId, workflow, pushOnMerge) =>
    set((s) => ({
      repos: updateRepo(s.repos, repoId, (r) => ({ ...r, workflow, pushOnMerge })),
    })),
  setRepoEnvNames: (repoId, names) =>
    set((s) => ({
      repos: updateRepo(s.repos, repoId, (r) => ({ ...r, cloudEnvNames: names })),
    })),

  openWorkflowModal: (repoId) => set({ workflowModalRepoId: repoId }),
  closeWorkflowModal: () => set({ workflowModalRepoId: null }),

  toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  setRightTab: (tab) => set({ rightTab: tab }),
  openRightTab: (tab) => set({ rightSidebarOpen: true, rightTab: tab }),

  openChatPicker: () => set({ chatPickerOpen: true }),
  closeChatPicker: () => set({ chatPickerOpen: false }),

  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
  setBottomTab: (tab) => set({ bottomTab: tab }),
  openBottomPanel: (tab) => set({ bottomPanelOpen: true, bottomTab: tab }),
  setShellStatus: (branchId, status) =>
    set((s) => ({ shellStatus: { ...s.shellStatus, [branchId]: status } })),

  setPendingHandoff: (branchId, timerId) =>
    set((s) => ({ pendingHandoff: { ...s.pendingHandoff, [branchId]: timerId } })),
  clearPendingHandoff: (branchId) =>
    set((s) => {
      if (!(branchId in s.pendingHandoff)) return s;
      const next = { ...s.pendingHandoff };
      delete next[branchId];
      return { pendingHandoff: next };
    }),

  setCloudRuns: (runs) =>
    set({ cloudRuns: Object.fromEntries(runs.map((r) => [r.run_id, r])) }),
  setCloudRun: (run) =>
    set((s) => ({ cloudRuns: { ...s.cloudRuns, [run.run_id]: run } })),
  removeCloudRun: (runId) =>
    set((s) => {
      if (!(runId in s.cloudRuns)) return s;
      const next = { ...s.cloudRuns };
      delete next[runId];
      return { cloudRuns: next };
    }),
  setCloudQuickStage: (repoId, branch, stage) =>
    set((s) => {
      const key = `${repoId}:${branch}`;
      if (stage === null) {
        if (!(key in s.cloudQuickStages)) return s;
        const next = { ...s.cloudQuickStages };
        delete next[key];
        return { cloudQuickStages: next };
      }
      return { cloudQuickStages: { ...s.cloudQuickStages, [key]: stage } };
    }),
  setCloudQuickError: (repoId, branch, reason) =>
    set((s) => {
      const key = `${repoId}:${branch}`;
      if (reason === null) {
        if (!(key in s.cloudQuickErrors)) return s;
        const next = { ...s.cloudQuickErrors };
        delete next[key];
        return { cloudQuickErrors: next };
      }
      return { cloudQuickErrors: { ...s.cloudQuickErrors, [key]: reason } };
    }),
  setCloudSettings: (cloud) => set((s) => ({ settings: { ...s.settings, cloud } })),
}));

export const cloudSettingsOf = (s: Settings): CloudSettings => {
  // `baseVm` belonged to the fork-era settings; a snapshot name replaces it.
  const { baseVm: _legacy, ...stored } = (s.cloud ?? {}) as Partial<CloudSettings> & { baseVm?: string };
  return { ...DEFAULT_CLOUD_SETTINGS, ...stored };
};

export const selectedRepo = (s: AppState) =>
  s.repos.find((r) => r.id === s.selection.repoId) ?? null;

export const selectedBranch = (s: AppState) => {
  const repo = selectedRepo(s);
  return repo?.branches.find((b) => b.id === s.selection.branchId) ?? null;
};
