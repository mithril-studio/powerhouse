import { load, type Store } from "@tauri-apps/plugin-store";
import { useAppStore, type PersistedTree } from "./appStore";

let storePromise: Promise<Store> | null = null;
const getStore = () =>
  (storePromise ??= load("powerhouse.json", { autoSave: false }));
export async function hydrateFromDisk() {
  const store = await getStore();
  const tree = await store.get<PersistedTree>("tree");
  if (tree && (tree.schemaVersion ?? 0) < 1) {
    await store.set("tree-before-tasks-v1", tree);
    await store.save();
  }
  useAppStore.getState().hydrate(tree ?? null);
}
let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let writes: Promise<void> = Promise.resolve();
export function flushPersistence(): Promise<void> {
  clearTimeout(timer);
  const { repos, selection, settings, queues, workflowDrafts, tasks } =
    useAppStore.getState();
  const tree: PersistedTree = {
    schemaVersion: 1,
    repos,
    selection,
    settings,
    queues,
    workflowDrafts,
    tasks,
  };
  const next = writes
    .catch(() => {})
    .then(async () => {
      const store = await getStore();
      await store.set("tree", tree);
      await store.save();
    });
  writes = next;
  return next;
}
/** Serialized writes prevent an older slow save from overwriting a launch receipt. */
export function startPersistence() {
  if (started) return;
  started = true;
  useAppStore.subscribe((s, prev) => {
    if (
      !s.hydrated ||
      (s.repos === prev.repos &&
        s.selection === prev.selection &&
        s.settings === prev.settings &&
        s.queues === prev.queues &&
        s.workflowDrafts === prev.workflowDrafts &&
        s.tasks === prev.tasks)
    )
      return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flushPersistence().catch((e) =>
        console.error("Could not save workspace", e),
      );
    }, 300);
  });
}
