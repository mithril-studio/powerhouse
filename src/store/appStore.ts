import { create } from "zustand";

export interface Chat {
  id: string;
  title: string;
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
  agentCmd: string;
}

interface AppState extends PersistedTree {
  hydrated: boolean;
  chatStatus: Record<string, ChatStatus>;
  branchModalRepoId: string | null;

  hydrate: (tree: Partial<PersistedTree> | null) => void;
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
}

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
  agentCmd: "claude",
  hydrated: false,
  chatStatus: {},
  branchModalRepoId: null,

  hydrate: (tree) =>
    set({
      repos: tree?.repos ?? [],
      selection: tree?.selection ?? { repoId: null, branchId: null },
      agentCmd: tree?.agentCmd || "claude",
      hydrated: true,
    }),

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
}));

export const selectedRepo = (s: AppState) =>
  s.repos.find((r) => r.id === s.selection.repoId) ?? null;

export const selectedBranch = (s: AppState) => {
  const repo = selectedRepo(s);
  return repo?.branches.find((b) => b.id === s.selection.branchId) ?? null;
};
