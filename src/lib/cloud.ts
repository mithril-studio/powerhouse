// Cloud workspaces: typed IPC, the poll loop that streams cloud turns into
// their chat, and the chat-level actions (send, message, stop, bring back).
// The VM does the work; this file only observes it and relays prompts.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  resolveAgent,
  resolveChatTransport,
  useAppStore,
  type Branch,
  type Repo,
} from "../store/appStore";
import { acpModel, detachAcp } from "./acpRegistry";
import {
  appendCloudResult,
  appendSystemMessage,
  appendUserMessage,
  applyAcpUpdate,
  type AcpTranscriptItem,
  type CloudResultItem,
} from "./acpTranscript";
import { handoffText, streamLineUpdates } from "./cloudStream";
import { ptyWrite } from "./ipc";
import { notifyTurnFinished } from "./attention";

// --- mirror of Rust `workspace.rs` (camelCase) ----------------------------------

export type CloudStatus = "creating" | "ready" | "running" | "done" | "failed" | "stopped";

export interface TurnResult {
  turn: number;
  ok: boolean;
  summary: string;
  head: string | null;
  unpushedCommits: number;
  dirtyFiles: number;
  local: string;
  costUsd: number | null;
}

export interface CloudWorkspace {
  id: string;
  repoId: string;
  branchId: string;
  branchName: string;
  worktreePath: string;
  remoteUrl: string;
  vmName: string;
  status: CloudStatus;
  stage: string | null;
  agent: string;
  model: string | null;
  chatId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  lastError: string | null;
  turn: number;
  logOffset: number;
  sessionId: string | null;
  lastResult: TurnResult | null;
}

interface PollResult {
  workspace: CloudWorkspace;
  lines: string[];
  turn: number;
}

export interface SecretStatus {
  claude: boolean;
  github: boolean;
  github_slot: string | null;
}

export interface EnvVarStatus {
  name: string;
  set: boolean;
}

interface StartRequest {
  repoId: string;
  branchId: string;
  worktreePath: string;
  chatId: string | null;
  agent: string;
  model: string | null;
  handoff: string;
  envNames: string[];
}

export const cloudWorkspaceList = () => invoke<CloudWorkspace[]>("cloud_workspace_list");
const cloudWorkspaceStart = (request: StartRequest) =>
  invoke<CloudWorkspace>("cloud_workspace_start", { request });
const cloudWorkspaceSend = (id: string, text: string, envNames: string[]) =>
  invoke<CloudWorkspace>("cloud_workspace_send", { id, text, envNames });
const cloudWorkspacePoll = (id: string) => invoke<PollResult>("cloud_workspace_poll", { id });
const cloudWorkspaceStop = (id: string) => invoke<void>("cloud_workspace_stop", { id });
const cloudWorkspaceArchive = (id: string) => invoke<void>("cloud_workspace_archive", { id });
const cloudWorkspacePull = (id: string) => invoke<string>("cloud_workspace_pull", { id });

export const cloudSecretStatus = (remoteUrl?: string | null) =>
  invoke<SecretStatus>("cloud_secret_status", { remoteUrl: remoteUrl ?? null });
export const cloudSetSecret = (name: string, value: string, remoteUrl?: string | null) =>
  invoke<SecretStatus>("cloud_set_secret", { name, value, remoteUrl: remoteUrl ?? null });
export const cloudProjectEnvStatus = (repoId: string, names: string[]) =>
  invoke<EnvVarStatus[]>("cloud_project_env_status", { repoId, names });

// --- selectors -------------------------------------------------------------------

export const isCloudBusy = (w: CloudWorkspace) => w.status === "creating" || w.status === "running";

export const workspaceForChat = (all: Record<string, CloudWorkspace>, chatId: string) =>
  Object.values(all).find((w) => w.chatId === chatId) ?? null;

export const workspaceForBranch = (all: Record<string, CloudWorkspace>, branchId: string) =>
  Object.values(all).find((w) => w.branchId === branchId) ?? null;

/** The card a settled turn posts into its chat. */
export function resultCard(w: CloudWorkspace, r: TurnResult): CloudResultItem {
  return {
    id: `cloud-result-${w.id}-${r.turn}`,
    type: "cloud-workspace-result",
    workspaceId: w.id,
    vmName: w.vmName,
    branch: w.branchName,
    turn: r.turn,
    ok: r.ok,
    status: w.status,
    summary: r.summary,
    pushedCommit: r.head,
    unpushedCommits: r.unpushedCommits,
    dirtyFiles: r.dirtyFiles,
    local: r.local,
    costUsd: r.costUsd,
  };
}

// --- chat plumbing ---------------------------------------------------------------

function locateChat(chatId: string): { repoId: string; branchId: string } | null {
  for (const repo of useAppStore.getState().repos) {
    for (const branch of repo.branches) {
      if (branch.chats.some((c) => c.id === chatId)) return { repoId: repo.id, branchId: branch.id };
    }
  }
  return null;
}

function mutateChat(chatId: string, update: (items: AcpTranscriptItem[]) => AcpTranscriptItem[]) {
  const where = locateChat(chatId);
  if (where) useAppStore.getState().updateChatAcpTranscript(where.repoId, where.branchId, chatId, update);
}

const note = (chatId: string, text: string, tone: "normal" | "error" = "normal") =>
  mutateChat(chatId, (items) => appendSystemMessage(items, text, tone));

/** Posts the settled turn's card once, and remembers its summary for the local
 *  session that picks the chat up later. */
function settle(w: CloudWorkspace) {
  const r = w.lastResult;
  if (!w.chatId || !r || isCloudBusy(w)) return;
  const card = resultCard(w, r);
  const chat = locateChat(w.chatId);
  if (!chat) return;
  const s = useAppStore.getState();
  const items = s.repos
    .find((repo) => repo.id === chat.repoId)
    ?.branches.find((b) => b.id === chat.branchId)
    ?.chats.find((c) => c.id === w.chatId);
  if (items?.acpTranscript?.some((i) => i.id === card.id)) return;
  s.updateChatAcpTranscript(chat.repoId, chat.branchId, w.chatId, (t) => appendCloudResult(t, card));
  const recap = [items?.cloudRecap, `Cloud turn ${r.turn} on ${w.vmName}: ${r.summary}`].filter(Boolean).join("\n");
  s.setChatCloudRecap(chat.repoId, chat.branchId, w.chatId, recap);
  void notifyTurnFinished(r.ok ? "done" : "error", `${w.branchName} · cloud`);
}

function applyPoll({ workspace, lines, turn }: PollResult) {
  useAppStore.getState().setCloudWorkspace(workspace);
  if (!workspace.chatId) return;
  if (lines.length > 0) {
    mutateChat(workspace.chatId, (items) =>
      lines.reduce(
        (acc, line, index) =>
          streamLineUpdates(line, `${workspace.id}-${turn}-${workspace.logOffset}-${index}`).reduce(
            (inner, update) => applyAcpUpdate(inner, update),
            acc,
          ),
        items,
      ),
    );
  }
  settle(workspace);
}

// --- sync loop -------------------------------------------------------------------

const POLL_MS = 2500;
let syncing = false;

/** Mirrors the backend store and streams running turns into their chats. */
export async function startCloudSync() {
  if (syncing) return;
  syncing = true;
  // Cards are posted by the poll that settles a turn, after its last lines.
  await listen<CloudWorkspace>("cloud-workspace-update", (e) =>
    useAppStore.getState().setCloudWorkspace(e.payload),
  );
  await listen<string>("cloud-workspace-removed", (e) =>
    useAppStore.getState().removeCloudWorkspace(e.payload),
  );
  const all = await cloudWorkspaceList();
  useAppStore.getState().setCloudWorkspaces(all);
  all.forEach(settle);
  const tick = async () => {
    const running = Object.values(useAppStore.getState().cloudWorkspaces).filter(
      (w) => w.status === "running",
    );
    await Promise.all(
      running.map((w) =>
        cloudWorkspacePoll(w.id)
          .then(applyPoll)
          .catch((e) => console.warn(`[cloud] poll ${w.vmName}: ${String(e)}`)),
      ),
    );
    window.setTimeout(() => void tick(), POLL_MS);
  };
  void tick();
}

// --- actions ---------------------------------------------------------------------

/**
 * The Cloud button: the active chat and its branch continue on a VM with the
 * same agent and model. The local agent is closed first so two agents never
 * edit one branch. A chat with no conversation yet provisions only; its next
 * message starts the cloud agent.
 */
export async function sendChatToCloud(repo: Repo, branch: Branch) {
  const s = useAppStore.getState();
  const chat = branch.chats.find((c) => c.id === branch.activeChatId);
  if (!chat) return;
  const profile = resolveAgent(s.settings, chat.agentId);
  if (profile.id !== "claude" || resolveChatTransport(s.settings, chat) !== "acp") {
    note(chat.id, "This agent cannot run in the cloud yet. Supported: Claude.", "error");
    return;
  }
  const chosen = acpModel(chat.id);
  const model = chosen && chosen !== "default" ? chosen : profile.defaultModel?.trim() || null;
  const handoff = handoffText(chat.acpTranscript ?? []);
  await detachAcp(chat.id);
  try {
    const w = await cloudWorkspaceStart({
      repoId: repo.id,
      branchId: branch.id,
      worktreePath: branch.worktreePath,
      chatId: chat.id,
      agent: profile.id,
      model,
      handoff,
      envNames: repo.cloudEnvNames ?? [],
    });
    useAppStore.getState().setCloudWorkspace(w);
    note(
      chat.id,
      handoff
        ? `Sent to the cloud on ${w.vmName}. The agent continues this conversation there and pushes to ${w.branchName}.`
        : `Starting ${w.vmName}. Your next message goes to the cloud agent.`,
    );
  } catch (cause) {
    note(chat.id, `Could not send to the cloud: ${String(cause)}`, "error");
  }
}

/** A follow-up prompt for the cloud agent; it resumes its own session. */
export async function messageCloud(w: CloudWorkspace, text: string) {
  if (!w.chatId) return;
  mutateChat(w.chatId, (items) => appendUserMessage(items, text));
  const envNames =
    useAppStore.getState().repos.find((r) => r.id === w.repoId)?.cloudEnvNames ?? [];
  try {
    useAppStore.getState().setCloudWorkspace(await cloudWorkspaceSend(w.id, text, envNames));
  } catch (cause) {
    note(w.chatId, `Cloud: ${String(cause)}`, "error");
  }
}

export async function stopCloud(w: CloudWorkspace) {
  try {
    await cloudWorkspaceStop(w.id);
  } catch (cause) {
    if (w.chatId) note(w.chatId, `Could not stop the cloud agent: ${String(cause)}`, "error");
  }
}

export async function pullCloud(w: CloudWorkspace) {
  try {
    const outcome = await cloudWorkspacePull(w.id);
    if (w.chatId) note(w.chatId, outcome);
  } catch (cause) {
    if (w.chatId) note(w.chatId, `Pull failed: ${String(cause)}`, "error");
  }
}

/**
 * Ends the cloud workspace: pulls what was pushed, destroys the VM, and hands
 * the chat back to the local agent (which gets a recap with its next prompt).
 * Work the agent left unpushed on the VM is lost, so that asks first.
 */
export async function bringCloudBack(w: CloudWorkspace) {
  const r = w.lastResult;
  if (isCloudBusy(w)) {
    if (!window.confirm(`The cloud agent is still working on ${w.vmName}. Stop it and delete the machine?`)) return;
    await cloudWorkspaceStop(w.id).catch(() => {});
  } else if (r && (r.unpushedCommits > 0 || r.dirtyFiles > 0)) {
    const lost = `${r.unpushedCommits} unpushed commit(s) and ${r.dirtyFiles} uncommitted file(s)`;
    if (!window.confirm(`${w.vmName} still has ${lost}. Deleting the machine loses them. Continue?`)) return;
  }
  try {
    const outcome = await cloudWorkspacePull(w.id).catch((e) => `Pull failed: ${String(e)}`);
    await cloudWorkspaceArchive(w.id);
    useAppStore.getState().removeCloudWorkspace(w.id);
    if (w.chatId) note(w.chatId, `Back local. ${outcome} ${w.vmName} was deleted.`);
  } catch (cause) {
    if (w.chatId) note(w.chatId, `Could not delete ${w.vmName}: ${String(cause)}`, "error");
  }
}

/** Deletes the VM and forgets the workspace, no questions asked. */
export async function deleteCloudWorkspace(id: string) {
  await cloudWorkspaceArchive(id);
  useAppStore.getState().removeCloudWorkspace(id);
}

/** Opens a shell on the VM in the bottom panel. */
export function openCloudShell(w: CloudWorkspace) {
  useAppStore.getState().openBottomPanel("shell");
  // The panel spawns its shell on first show; give it a moment.
  window.setTimeout(() => void ptyWrite(`shell-${w.branchId}`, `boxd connect ${w.vmName}\r`).catch(() => {}), 600);
}
