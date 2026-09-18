// Keeps the Zustand queue mirror in sync with the Rust engine. The engine
// emits a full snapshot on `queue-update-<repoId>` for every transition; we
// also do an initial `queueState()` resync so a webview reload never loses a
// running entry.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore, type QueueEntry } from "../store/appStore";
import { queueState } from "./ipc";

const subscriptions = new Map<string, UnlistenFn>();

async function subscribe(repoId: string) {
  if (subscriptions.has(repoId)) return;
  // Reserve the slot synchronously so a rapid re-diff doesn't double-subscribe.
  subscriptions.set(repoId, () => {});
  const unlisten = await listen<QueueEntry[]>(`queue-update-${repoId}`, (e) => {
    useAppStore.getState().setQueueEntries(repoId, e.payload);
  });
  subscriptions.set(repoId, unlisten);
  // Initial resync (covers entries enqueued before this listener attached).
  try {
    const entries = await queueState(repoId);
    useAppStore.getState().setQueueEntries(repoId, entries);
  } catch {
    // engine has no queue for this repo yet — nothing to resync
  }
}

function unsubscribe(repoId: string) {
  const unlisten = subscriptions.get(repoId);
  if (unlisten) unlisten();
  subscriptions.delete(repoId);
}

/** Call once from App boot; re-diffs subscriptions whenever repos change. */
export function startQueueSync() {
  const sync = (repoIds: string[]) => {
    const wanted = new Set(repoIds);
    for (const id of subscriptions.keys()) {
      if (!wanted.has(id)) unsubscribe(id);
    }
    for (const id of wanted) void subscribe(id);
  };

  sync(useAppStore.getState().repos.map((r) => r.id));
  useAppStore.subscribe((s, prev) => {
    if (s.repos === prev.repos) return;
    sync(s.repos.map((r) => r.id));
  });
}
