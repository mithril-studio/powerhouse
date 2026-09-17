import { create } from "zustand";

export interface Chat {
  id: string;
  title: string;
}

/** Per-branch main content view. */
export type BranchView = "chat" | "diff";

export interface Branch {
  id: string;
  name: string;
  worktreePath: string;
  chats: Chat[];
  activeChatId: string | null;
  /** Set true once this branch lands on main via the queue (green dot). */
  merged?: boolean;
  activeView?: BranchView;
}

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
}

export interface Selection {
  repoId: string | null;
  branchId: string | null;
  view?: "queue";
}

/** Runtime-only; terminals/PTYs are never persisted. */
export type ChatStatus = "idle" | "running" | "exited";

export interface PersistedTree {
  repos: Repo[];
  selection: Selection;
  agentCmd: string;
  queues: Record<string, QueueEntry[]>;
}

interface AppState extends PersistedTree {
  hydrated: boolean;
  chatStatus: Record<string, ChatStatus>;
  branchModalRepoId: string | null;
  workflowModalRepoId: string | null;

  hydrate: (tree: Partial<PersistedTree> | null) => void;
  addRepo: (repo: Omit<Repo, "id" | "branches" | "workflow" | "pushOnMerge">) => Repo;
  addBranch: (repoId: string, branch: Branch) => void;
  removeBranch: (repoId: string, branchId: string) => void;
  addChat: (repoId: string, branchId: string, chat: Chat) => void;
  removeChat: (repoId: string, branchId: string, chatId: string) => void;
  setActiveChat: (repoId: string, branchId: string, chatId: string) => void;
  select: (repoId: string | null, branchId: string | null) => void;
  setChatStatus: (chatId: string, status: ChatStatus) => void;
  openBranchModal: (repoId: string) => void;
  closeBranchModal: () => void;

  setQueueEntries: (repoId: string, live: QueueEntry[]) => void;
  dismissQueueEntry: (repoId: string, entryId: string) => void;
  setWorkflow: (repoId: string, workflow: WorkflowStep[], pushOnMerge: boolean) => void;
  selectQueue: (repoId: string) => void;
  openWorkflowModal: (repoId: string) => void;
  closeWorkflowModal: () => void;
  setBranchView: (repoId: string, branchId: string, view: BranchView) => void;
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
  queues: {},
  hydrated: false,
  chatStatus: {},
  branchModalRepoId: null,
  workflowModalRepoId: null,

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
      agentCmd: tree?.agentCmd || "claude",
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

  addRepo: (repo) => {
    const existing = get().repos.find((r) => r.path === repo.path);
    if (existing) {
      set({ selection: { repoId: existing.id, branchId: null } });
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

  selectQueue: (repoId) =>
    set({ selection: { repoId, branchId: null, view: "queue" } }),

  openWorkflowModal: (repoId) => set({ workflowModalRepoId: repoId }),
  closeWorkflowModal: () => set({ workflowModalRepoId: null }),

  setBranchView: (repoId, branchId, view) =>
    set((s) => ({
      repos: updateBranch(s.repos, repoId, branchId, (b) => ({
        ...b,
        activeView: view,
      })),
    })),
}));

export const selectedRepo = (s: AppState) =>
  s.repos.find((r) => r.id === s.selection.repoId) ?? null;

export const selectedBranch = (s: AppState) => {
  const repo = selectedRepo(s);
  return repo?.branches.find((b) => b.id === s.selection.branchId) ?? null;
};
