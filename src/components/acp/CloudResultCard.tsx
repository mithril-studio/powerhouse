import { useAppStore } from "../../store/appStore";
import { bringCloudBack, openCloudShell, pullCloud } from "../../lib/cloud";
import type { CloudResultItem } from "../../lib/acpTranscript";
import { AcpMarkdown } from "./AcpMarkdown";

/** What a finished cloud turn posts into its chat. Actions show only while
 *  the workspace still exists. */
export function CloudResultCard({ item }: { item: CloudResultItem }) {
  const workspace = useAppStore((s) => s.cloudWorkspaces[item.workspaceId]);
  const openRightTab = useAppStore((s) => s.openRightTab);
  const leftBehind = [
    item.unpushedCommits > 0 && `${item.unpushedCommits} unpushed commit(s)`,
    item.dirtyFiles > 0 && `${item.dirtyFiles} uncommitted file(s)`,
  ].filter(Boolean);
  const heading = item.ok ? "Cloud finished" : item.status === "stopped" ? "Cloud stopped" : "Cloud failed";
  const button = "h-6 border border-border px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground";
  return (
    <section
      aria-label="Cloud result"
      className={`border-l-2 bg-card/60 px-3 py-2 text-xs ${item.ok ? "border-success" : "border-destructive"}`}
    >
      <p className="mb-1 font-medium text-foreground">
        ☁ {heading} on {item.vmName}
        <span className="ml-2 font-normal text-muted-foreground">
          {item.branch}
          {item.pushedCommit ? ` @ ${item.pushedCommit.slice(0, 7)}` : ""}
          {item.costUsd != null ? ` · $${item.costUsd.toFixed(2)}` : ""}
        </span>
      </p>
      {item.summary && <AcpMarkdown text={item.summary} className="text-muted-foreground" />}
      <p className="mt-1 text-muted-foreground">{item.local}</p>
      {leftBehind.length > 0 && (
        <p className="mt-1 text-destructive">Not on the branch yet: {leftBehind.join(" and ")} on the VM.</p>
      )}
      {workspace && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button onClick={() => openRightTab("diff")} className={button}>
            View diff
          </button>
          <button onClick={() => void pullCloud(workspace)} className={button}>
            Pull latest
          </button>
          <button onClick={() => openCloudShell(workspace)} className={button}>
            Open VM
          </button>
          <button onClick={() => void bringCloudBack(workspace)} className={button}>
            Bring back local
          </button>
        </div>
      )}
    </section>
  );
}
