import { useAppStore, type Branch, type Repo } from "../store/appStore";
import { deleteBranch, enqueueBranch } from "../lib/actions";
import { holdsResources } from "../lib/cloud";
import { quickSubmitBranch } from "../lib/quickSubmit";
import { rollupActivity } from "../lib/chatActivity";
import { ActivityDot } from "./ActivityDot";

const QUICK_STAGE_LABEL: Record<string, string> = {
  starting: "sending",
  checkpointing: "checkpointing",
  pushing: "pushing",
  submitting: "submitting",
};

interface Props {
  repo: Repo;
  branch: Branch;
}

export function BranchItem({ repo, branch }: Props) {
  const select = useAppStore((s) => s.select);
  const setActiveChat = useAppStore((s) => s.setActiveChat);
  // "In cloud" while a run from this branch still holds a VM or park
  // snapshot; clears on release/discard.
  const inCloud = useAppStore((s) =>
    Object.values(s.cloudRuns).some(
      (r) => r.repo_id === repo.id && r.source_branch === branch.name && holdsResources(r),
    ),
  );
  const quickStage = useAppStore((s) => s.cloudQuickStages[`${repo.id}:${branch.name}`]);
  const selected = useAppStore(
    (s) => s.selection.repoId === repo.id && s.selection.branchId === branch.id,
  );
  const queued = useAppStore((s) =>
    (s.queues[repo.id] ?? []).some(
      (e) =>
        e.branch === branch.name &&
        (e.state === "queued" || e.state === "validating" || e.state === "merging"),
    ),
  );

  // Agent activity across this worktree's chats outranks the static dot.
  const activity = useAppStore((s) =>
    rollupActivity(branch.chats.map((c) => c.id), s.chatActivity),
  );

  const onSelect = () => {
    select(repo.id, branch.id);
    if (!branch.activeChatId && branch.chats.length > 0) {
      setActiveChat(repo.id, branch.id, branch.chats[0].id);
    }
  };

  return (
    <div
      onClick={onSelect}
      className={`group flex h-7 cursor-default items-center gap-2 rounded-md pl-6 pr-1.5 ${
        selected
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      }`}
    >
      {activity ? (
        <ActivityDot activity={activity} />
      ) : (
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            branch.merged
              ? "bg-success"
              : queued
                ? "animate-pulse bg-accent-brand"
                : selected
                  ? "bg-accent-brand"
                  : "bg-muted-foreground/40"
          }`}
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{branch.name}</span>
      {quickStage ? (
        <span
          title={`Sending to cloud: ${QUICK_STAGE_LABEL[quickStage] ?? quickStage}`}
          className="shrink-0 animate-pulse text-[10px] text-accent-brand"
        >
          ☁ {QUICK_STAGE_LABEL[quickStage] ?? quickStage}…
        </span>
      ) : (
        inCloud && (
          <span title="This branch is in the cloud (a run still holds its VM or snapshot)" className="shrink-0 text-[10px] text-accent-brand">
            ☁
          </span>
        )
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          void quickSubmitBranch(repo, branch);
        }}
        title="Send to cloud"
        aria-label={`Send ${branch.name} to cloud`}
        disabled={!!quickStage}
        className="hidden size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground group-hover:flex disabled:opacity-40"
      >
        ☁
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void enqueueBranch(repo.id, branch.id);
        }}
        title="Enqueue for merge"
        aria-label={`Enqueue ${branch.name}`}
        disabled={queued}
        className="hidden size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground group-hover:flex disabled:opacity-40"
      >
        ⇧
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void deleteBranch(repo.id, branch.id);
        }}
        title="Delete branch (⌘⇧⌫)"
        aria-label={`Delete branch ${branch.name}`}
        className="hidden size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-destructive group-hover:flex"
      >
        ×
      </button>
    </div>
  );
}
