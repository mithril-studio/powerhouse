/** Drafts are edited locally; publishing pins them to the coordinator. */
export interface ScriptDraft {
  id: string;
  name: string;
  command: string;
}

export interface WorkflowDraft {
  id: string;
  repoId: string;
  name: string;
  steps: ScriptDraft[];
  /** Set once the draft has been published to the coordinator. */
  serverWorkflowId?: string;
  publishedVersion?: number;
  /** Content fingerprint at last publish — detects unpublished edits. */
  publishedKey?: string;
  /** Coordinator run ids started from this draft, newest first. */
  runIds?: string[];
}

export const newScriptDraft = (): ScriptDraft => ({
  id: crypto.randomUUID(), name: "Script", command: "",
});

export const newWorkflowDraft = (repoId: string): WorkflowDraft => ({
  id: crypto.randomUUID(), repoId, name: "Untitled workflow", steps: [newScriptDraft()],
});
