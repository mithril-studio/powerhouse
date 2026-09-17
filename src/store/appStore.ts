import { create } from "zustand";

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
}

export interface Settings {
  agents: AgentProfile[];
  defaultAgentId: string;
}

export interface Branch {
  id: string;
  name: string;
  worktreePath: string;
  chats: Chat[];
  activeChatId: string | null;
}

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  branches: Branch[];
}

export interface Selection {
  repoId: string | null;
  branchId: string | null;
}

/** Runtime-only; terminals/PTYs are never persisted. */
export type ChatStatus = "idle" | "running" | "exited";

export interface PersistedTree {
  repos: Repo[];
  selection: Selection;
  settings: Settings;
}

/** Old persisted shape (pre agent-profiles) — read only during migration. */
interface LegacyTree {
  agentCmd?: string;
}

interface AppState extends PersistedTree {
  hydrated: boolean;
  chatStatus: Record<string, ChatStatus>;
  branchModalRepoId: string | null;
  chatPickerOpen: boolean;
  bottomPanelOpen: boolean;
  shellStatus: Record<string, ChatStatus>;
  /** branchId → setTimeout id of the in-flight handoff (presence = pending). */
  pendingHandoff: Record<string, number>;

  hydrate: (tree: (Partial<PersistedTree> & LegacyTree) | null) => void;
  setDefaultAgent: (agentId: string) => void;
  addRepo: (repo: Omit<Repo, "id" | "branches">) => Repo;
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
  select: (repoId: string | null, branchId: string | null) => void;
  setChatStatus: (chatId: string, status: ChatStatus) => void;
  openBranchModal: (repoId: string) => void;
  closeBranchModal: () => void;
  openChatPicker: () => void;
  closeChatPicker: () => void;
  toggleBottomPanel: () => void;
  setShellStatus: (branchId: string, status: ChatStatus) => void;
  setPendingHandoff: (branchId: string, timerId: number) => void;
  clearPendingHandoff: (branchId: string) => void;
}

const SEED_AGENTS: AgentProfile[] = [
  {
    id: "claude",
    name: "Claude",
    command: "claude",
    promptTemplate: 'claude "{prompt}"',
    startTemplate: "claude --session-id {sessionId}",
    startPromptTemplate: 'claude --session-id {sessionId} "{prompt}"',
    resumeTemplate: "claude --resume {sessionId}",
  },
  { id: "codex", name: "Codex", command: "codex", promptTemplate: 'codex "{prompt}"' },
  { id: "pi", name: "Pi", command: "pi", promptTemplate: 'pi "{prompt}"' },
];

const seedSettings = (): Settings => ({
  agents: SEED_AGENTS.map((a) => ({ ...a })),
  defaultAgentId: "claude",
});

/** Backfills resume templates onto known seed agents that predate them, leaving
 *  custom agents and any user-edited fields untouched. */
function backfillResumeFields(agents: AgentProfile[]): AgentProfile[] {
  const seedById = Object.fromEntries(SEED_AGENTS.map((a) => [a.id, a]));
  return agents.map((a) => {
    const seed = seedById[a.id];
    if (!seed) return a;
    return {
      ...a,
      startTemplate: a.startTemplate ?? seed.startTemplate,
      startPromptTemplate: a.startPromptTemplate ?? seed.startPromptTemplate,
      resumeTemplate: a.resumeTemplate ?? seed.resumeTemplate,
    };
  });
}

/** Migrates the old `agentCmd` string into agent profiles, or passes settings through. */
function migrateSettings(tree: (Partial<PersistedTree> & LegacyTree) | null): Settings {
  if (tree?.settings && tree.settings.agents?.length) {
    const { defaultAgentId } = tree.settings;
    const agents = backfillResumeFields(tree.settings.agents);
    const validDefault = agents.some((a) => a.id === defaultAgentId);
    return { agents, defaultAgentId: validDefault ? defaultAgentId : agents[0].id };
  }
  const agents = SEED_AGENTS.map((a) => ({ ...a }));
  const legacy = tree?.agentCmd?.trim();
  if (legacy) {
    const match = agents.find((a) => a.command === legacy);
    if (match) return { agents, defaultAgentId: match.id };
    const custom: AgentProfile = {
      id: crypto.randomUUID(),
      name: legacy,
      command: legacy,
      promptTemplate: `${legacy} "{prompt}"`,
    };
    return { agents: [custom, ...agents], defaultAgentId: custom.id };
  }
  return { agents, defaultAgentId: "claude" };
}

/** Resolves the profile for a chat, falling back to the default agent. */
export const resolveAgent = (settings: Settings, agentId?: string): AgentProfile =>
  settings.agents.find((a) => a.id === agentId) ??
  settings.agents.find((a) => a.id === settings.defaultAgentId) ??
  settings.agents[0];

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
  selection: { repoId: null, branchId: null },
  settings: seedSettings(),
  hydrated: false,
  chatStatus: {},
  branchModalRepoId: null,
  chatPickerOpen: false,
  bottomPanelOpen: false,
  shellStatus: {},
  pendingHandoff: {},

  hydrate: (tree) =>
    set({
      repos: tree?.repos ?? [],
      selection: tree?.selection ?? { repoId: null, branchId: null },
      settings: migrateSettings(tree),
      hydrated: true,
    }),

  setDefaultAgent: (agentId) =>
    set((s) =>
      s.settings.agents.some((a) => a.id === agentId)
        ? { settings: { ...s.settings, defaultAgentId: agentId } }
        : s,
    ),

  addRepo: (repo) => {
    const existing = get().repos.find((r) => r.path === repo.path);
    if (existing) {
      set({ selection: { repoId: existing.id, branchId: null } });
      return existing;
    }
    const created: Repo = { ...repo, id: crypto.randomUUID(), branches: [] };
    set((s) => ({
      repos: [...s.repos, created],
      selection: { repoId: created.id, branchId: null },
    }));
    return created;
  },

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

  select: (repoId, branchId) => set({ selection: { repoId, branchId } }),

  setChatStatus: (chatId, status) =>
    set((s) => ({ chatStatus: { ...s.chatStatus, [chatId]: status } })),

  openBranchModal: (repoId) => set({ branchModalRepoId: repoId }),
  closeBranchModal: () => set({ branchModalRepoId: null }),
  openChatPicker: () => set({ chatPickerOpen: true }),
  closeChatPicker: () => set({ chatPickerOpen: false }),

  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
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
}));

export const selectedRepo = (s: AppState) =>
  s.repos.find((r) => r.id === s.selection.repoId) ?? null;

export const selectedBranch = (s: AppState) => {
  const repo = selectedRepo(s);
  return repo?.branches.find((b) => b.id === s.selection.branchId) ?? null;
};
