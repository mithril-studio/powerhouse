/** Local drafts only. Publishing and remote runs belong to the future service. */
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
}

export const newScriptDraft = (): ScriptDraft => ({
  id: crypto.randomUUID(), name: "Script", command: "",
});

export const newWorkflowDraft = (repoId: string): WorkflowDraft => ({
  id: crypto.randomUUID(), repoId, name: "Untitled workflow", steps: [newScriptDraft()],
});
