import { useAppStore, type Branch, type Repo } from "../store/appStore";
import { provisionCloudBranch } from "../lib/actions";

/**
 * Shown in place of a cloud branch's chat until its VM exists: creating,
 * failed (with the reason and Retry), or interrupted by an app quit.
 */
export function VmProvisioningPanel({ repo, branch }: { repo: Repo; branch: Branch }) {
  const creating = useAppStore((s) => Boolean(s.vmCreating[branch.id]));
  const openProjectSettings = useAppStore((s) => s.openProjectSettings);
  const retry = () => void provisionCloudBranch(repo.id, branch.id);
  const needsImage = branch.vmError?.includes("no VM image");

  return (
    <div className="absolute inset-0 flex items-center justify-center p-8">
      <div className="max-w-md space-y-3 text-center text-sm">
        {creating ? (
          <>
            <p className="font-medium">Creating the VM for {branch.name}…</p>
            <p className="text-muted-foreground">
              Restoring {repo.name}'s VM image, checking out the branch and running setup. Usually under a minute.
            </p>
          </>
        ) : branch.vmError ? (
          <>
            <p className="font-medium">The VM could not be created</p>
            <p className="select-text whitespace-pre-wrap text-xs text-destructive">{branch.vmError}</p>
            <div className="flex justify-center gap-2">
              {needsImage && (
                <button onClick={() => openProjectSettings(repo.id)} className="pi-btn h-8 px-3">
                  Open Project settings
                </button>
              )}
              <button onClick={retry} className="pi-btn pi-btn-primary h-8 px-3">
                Retry
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="font-medium">This cloud branch has no VM yet</p>
            <p className="text-muted-foreground">Creating it was interrupted.</p>
            <button onClick={retry} className="pi-btn pi-btn-primary h-8 px-3">
              Create VM
            </button>
          </>
        )}
      </div>
    </div>
  );
}
