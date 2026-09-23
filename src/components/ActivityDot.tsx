import type { ChatActivity } from "../store/appStore";

const LABEL: Record<ChatActivity, string> = {
  working: "Agent working",
  done: "Finished — not viewed yet",
  error: "Stopped with an error",
};

const CLASS: Record<ChatActivity, string> = {
  working: "size-2.5 animate-spin rounded-full border border-accent-brand border-t-transparent",
  done: "size-2 rounded-full bg-success",
  error: "size-2 rounded-full bg-destructive",
};

/** Agent turn state for a chat or worktree: spinner while working, dot when unseen. */
export function ActivityDot({ activity }: { activity: ChatActivity }) {
  return (
    <span
      role="img"
      title={LABEL[activity]}
      aria-label={LABEL[activity]}
      className={`shrink-0 ${CLASS[activity]}`}
    />
  );
}
