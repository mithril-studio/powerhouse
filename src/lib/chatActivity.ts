import type { StopReason } from "@agentclientprotocol/sdk";
import type { ChatActivity } from "../store/appStore";

/**
 * Maps how an agent turn ended to the badge it leaves behind. A cancelled
 * turn was stopped by the user, so it leaves no badge.
 */
export function activityFromStopReason(stopReason: StopReason): ChatActivity | null {
  switch (stopReason) {
    case "cancelled":
      return null;
    case "refusal":
      return "error";
    default:
      return "done";
  }
}

const PRIORITY: ChatActivity[] = ["working", "error", "done"];

/** The most urgent activity across a set of chats (e.g. a worktree's chats). */
export function rollupActivity(
  chatIds: string[],
  activity: Record<string, ChatActivity>,
): ChatActivity | null {
  const present = new Set(chatIds.map((id) => activity[id]));
  return PRIORITY.find((state) => present.has(state)) ?? null;
}
