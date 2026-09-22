import { cloudSettingsOf, useAppStore, type Branch, type Repo, type Settings } from "../store/appStore";
import { cloudQuickSubmit, type QuickSubmitRequest } from "./cloud";

/** The one-click request: last-used settings, the repo's workflow as checks. */
export function buildQuickSubmitRequest(repo: Repo, sourcePath: string, settings: Settings): QuickSubmitRequest {
  const cloud = cloudSettingsOf(settings);
  return {
    repoId: repo.id,
    repoPath: repo.path,
    repoName: repo.name,
    sourcePath,
    baseSnapshot: cloud.baseSnapshot.trim(),
    machineCeiling: cloud.machineCeiling,
    checks: repo.workflow.map((w) => ({ name: w.name, command: w.command })).filter((c) => c.command.trim()),
    deadlineSeconds: Math.max(1, Math.round(cloud.deadlineMinutes)) * 60,
    permissionMode: cloud.permissionMode,
    allowedTools: cloud.allowedTools.split(",").map((t) => t.trim()).filter(Boolean),
    maxTurns: cloud.maxTurns,
    maxBudgetUsd: cloud.maxBudgetUsd,
    model: cloud.model.trim() || null,
    provider: "claude",
    envNames: repo.cloudEnvNames ?? [],
  };
}

/**
 * One-click "Send to cloud" for a branch. Accepted → the run appears in the
 * Cloud tab; anything needing the user opens the advanced form with the
 * reason. The backend announces checkpoint/push/submit stages by event.
 */
export async function quickSubmitBranch(repo: Repo, branch: Branch): Promise<void> {
  const s = useAppStore.getState();
  if (s.cloudQuickStages[`${repo.id}:${branch.name}`]) return;
  s.setCloudQuickStage(repo.id, branch.name, "starting");
  try {
    const out = await cloudQuickSubmit(buildQuickSubmitRequest(repo, branch.worktreePath, s.settings));
    const st = useAppStore.getState();
    if (out.kind === "accepted") {
      st.setCloudRun(out.record);
      st.openRightTab("cloud");
    } else {
      st.openCloudModal(repo.id, branch.worktreePath, branch.name, out.reason);
    }
  } catch (e) {
    useAppStore.getState().openCloudModal(repo.id, branch.worktreePath, branch.name, String(e));
  } finally {
    useAppStore.getState().setCloudQuickStage(repo.id, branch.name, null);
  }
}
