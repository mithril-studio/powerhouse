import {
  cloudSettingsOf,
  resolveAgent,
  resolveChatTransport,
  useAppStore,
  type Branch,
  type Chat,
  type Repo,
  type Settings,
} from "../store/appStore";
import { acpModel, detachAcp } from "./acpRegistry";
import { cloudQuickSubmit, type QuickSubmitRequest } from "./cloud";

/** What travels when the chat itself goes to the cloud. */
export interface ChatHandoff {
  agentSessionId: string;
  /** The model the chat runs, so the cloud continues with the same one. */
  model: string | null;
}

/** The one-click request: last-used settings, the repo's workflow as checks. */
export function buildQuickSubmitRequest(
  repo: Repo,
  sourcePath: string,
  settings: Settings,
  chatId: string | null = null,
  handoff: ChatHandoff | null = null,
): QuickSubmitRequest {
  const cloud = cloudSettingsOf(settings);
  return {
    repoId: repo.id,
    repoPath: repo.path,
    repoName: repo.name,
    sourcePath,
    chatId,
    baseSnapshot: cloud.baseSnapshot.trim(),
    machineCeiling: cloud.machineCeiling,
    checks: repo.workflow.map((w) => ({ name: w.name, command: w.command })).filter((c) => c.command.trim()),
    deadlineSeconds: Math.max(1, Math.round(cloud.deadlineMinutes)) * 60,
    permissionMode: cloud.permissionMode,
    allowedTools: cloud.allowedTools.split(",").map((t) => t.trim()).filter(Boolean),
    maxTurns: cloud.maxTurns,
    maxBudgetUsd: cloud.maxBudgetUsd,
    model: handoff?.model || cloud.model.trim() || null,
    provider: "claude",
    envNames: repo.cloudEnvNames ?? [],
    agentSessionId: handoff?.agentSessionId ?? null,
  };
}

/**
 * A Claude chat over ACP can travel: stop its turn, close the agent so the
 * transcript on disk is final, and report the session and model. Other chats
 * (PTY, other agents, never started) send the branch only.
 */
export async function prepareChatHandoff(
  settings: Settings,
  chat: Chat | undefined,
): Promise<ChatHandoff | null> {
  if (!chat?.agentSessionId) return null;
  const profile = resolveAgent(settings, chat.agentId);
  if (profile.id !== "claude" || resolveChatTransport(settings, chat) !== "acp") return null;
  const chosen = acpModel(chat.id);
  const model = chosen && chosen !== "default" ? chosen : profile.defaultModel?.trim() || null;
  await detachAcp(chat.id);
  return { agentSessionId: chat.agentSessionId, model };
}

/**
 * One-click "Send to cloud". Accepted → the run appears in the Cloud tab;
 * anything needing the user shows up there as a dismissible reason card
 * (credentials and run defaults live in Settings, env vars in the repo's
 * workflow modal). The backend announces checkpoint/push/submit stages.
 */
export async function quickSubmit(
  repo: Repo,
  sourcePath: string,
  branchLabel: string,
  chatId: string | null = null,
  chat?: Chat,
): Promise<void> {
  const s = useAppStore.getState();
  if (s.cloudQuickStages[`${repo.id}:${branchLabel}`]) return;
  s.setCloudQuickStage(repo.id, branchLabel, "starting");
  s.setCloudQuickError(repo.id, branchLabel, null);
  s.openRightTab("cloud");
  try {
    const handoff = await prepareChatHandoff(s.settings, chat);
    const out = await cloudQuickSubmit(
      buildQuickSubmitRequest(repo, sourcePath, s.settings, chatId, handoff),
    );
    const st = useAppStore.getState();
    if (out.kind === "accepted") {
      st.setCloudRun(out.record);
    } else {
      st.setCloudQuickError(repo.id, branchLabel, out.reason);
    }
  } catch (e) {
    useAppStore.getState().setCloudQuickError(repo.id, branchLabel, String(e));
  } finally {
    useAppStore.getState().setCloudQuickStage(repo.id, branchLabel, null);
  }
}

/** The chat button: the branch and its active chat go to the cloud together. */
export const quickSubmitBranch = (repo: Repo, branch: Branch) =>
  quickSubmit(
    repo,
    branch.worktreePath,
    branch.name,
    branch.activeChatId,
    branch.chats.find((c) => c.id === branch.activeChatId),
  );
