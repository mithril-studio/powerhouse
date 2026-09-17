import { create } from "zustand";

export interface Chat {
  id: string;
  title: string;
  /** Absent = use the default agent. */
  agentId?: string;
  /** When set, the agent is launched via its promptTemplate instead of bare command. */
  initialPrompt?: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  command: string; // e.g. "claude"
  promptTemplate: string; // e.g. 'claude "{prompt}"'
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
  { id: "claude", name: "Claude", command: "claude", promptTemplate: 'claude "{prompt}"' },
  { id: "codex", name: "Codex", command: "codex", promptTemplate: 'codex "{prompt}"' },
  { id: "pi", name: "Pi", command: "pi", promptTemplate: 'pi "{prompt}"' },
];

const seedSettings = (): Settings => ({
  agents: SEED_AGENTS.map((a) => ({ ...a })),
  defaultAgentId: "claude",
});

/** Migrates the old `agentCmd` string into agent profiles, or passes settings through. */
function migrateSettings(tree: (Partial<PersistedTree> & LegacyTree) | null): Settings {
  if (tree?.settings && tree.settings.agents?.length) {
    const { agents, defaultAgentId } = tree.settings;
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
