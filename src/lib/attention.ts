// Pulls the user back when an agent finishes while Powerhouse is in the
// background: an OS notification per finished turn, and a dock badge counting
// chats with a finished turn nobody has looked at yet.
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useAppStore, type ChatActivity } from "../store/appStore";
import { unseenCount } from "./chatActivity";

let permission: Promise<boolean> | null = null;

function notificationsAllowed(): Promise<boolean> {
  permission ??= isPermissionGranted()
    .then((granted) => granted || requestPermission().then((p) => p === "granted"))
    .catch(() => false);
  return permission;
}

/** Notifies about a finished turn, but only when the app isn't focused. */
export async function notifyTurnFinished(
  outcome: Exclude<ChatActivity, "working">,
  where: string,
) {
  if (document.hasFocus() || !(await notificationsAllowed())) return;
  sendNotification({
    title: outcome === "done" ? "Agent finished" : "Agent stopped with an error",
    body: where,
  });
}

/** Call once from App boot; keeps the dock badge equal to the unseen count. */
export function startDockBadge() {
  let shown = 0;
  const sync = (activity: Record<string, ChatActivity>) => {
    const count = unseenCount(activity);
    if (count === shown) return;
    shown = count;
    void getCurrentWindow()
      .setBadgeCount(count > 0 ? count : undefined)
      .catch(() => {});
  };
  sync(useAppStore.getState().chatActivity);
  useAppStore.subscribe((s, prev) => {
    if (s.chatActivity !== prev.chatActivity) sync(s.chatActivity);
  });
}
