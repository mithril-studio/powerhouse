import { useAppStore, type Branch, type Repo } from "../store/appStore";
import { provisionCloudBranch } from "../lib/actions";
import { RefreshIcon } from "./ui/icons";

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
    <div className="absolute inset-0 flex p-8">
      <div className="ph-empty space-y-4">
        {creating ? (
          <div>
            <h2 className="flex items-center justify-center gap-2">
              <RefreshIcon className="size-3.5 animate-spin text-muted-foreground" />
              Creating the VM
            </h2>
            <p>
              Restoring {repo.name}'s VM image, checking out{" "}
              <span className="whitespace-nowrap font-mono text-xs">{branch.name}</span> and running setup. Usually under a
              minute.
            </p>
          </div>
        ) : branch.vmError ? (
          <>
            <div>
              <h2>The VM could not be created</h2>
              <p className="max-h-40 select-text overflow-y-auto whitespace-pre-wrap font-mono text-xs text-destructive [overflow-wrap:anywhere]">
                {branch.vmError}
              </p>
            </div>
            <div className="flex justify-center gap-2">
              {needsImage && (
                <button onClick={() => openProjectSettings(repo.id)} className="ph-btn">
                  Open project settings
                </button>
              )}
              <button onClick={retry} className="ph-btn ph-btn-primary">
                Retry
              </button>
            </div>
          </>
        ) : (
          <>
            <div>
              <h2>This branch has no VM yet</h2>
              <p>Creating it was interrupted.</p>
            </div>
            <button onClick={retry} className="ph-btn ph-btn-primary">
              Create VM
            </button>
          </>
        )}
      </div>
    </div>
  );
}
