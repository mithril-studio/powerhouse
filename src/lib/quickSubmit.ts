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
 * One-click "Send to cloud". Accepted → the run appears in the Cloud tab;
 * anything needing the user shows up there as a dismissible reason card
 * (credentials and run defaults live in Settings, env vars in the repo's
 * workflow modal). The backend announces checkpoint/push/submit stages.
 */
export async function quickSubmit(repo: Repo, sourcePath: string, branchLabel: string): Promise<void> {
  const s = useAppStore.getState();
  if (s.cloudQuickStages[`${repo.id}:${branchLabel}`]) return;
  s.setCloudQuickStage(repo.id, branchLabel, "starting");
  s.setCloudQuickError(repo.id, branchLabel, null);
  s.openRightTab("cloud");
  try {
    const out = await cloudQuickSubmit(buildQuickSubmitRequest(repo, sourcePath, s.settings));
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

export const quickSubmitBranch = (repo: Repo, branch: Branch) => quickSubmit(repo, branch.worktreePath, branch.name);
