import { load, type Store } from "@tauri-apps/plugin-store";
import { useAppStore, type PersistedTree } from "./appStore";

let storePromise: Promise<Store> | null = null;
const getStore = () => (storePromise ??= load("powerhouse.json", { autoSave: false }));

export async function hydrateFromDisk() {
  const store = await getStore();
  const tree = await store.get<PersistedTree>("tree");
  useAppStore.getState().hydrate(tree ?? null);
}

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let writes: Promise<void> = Promise.resolve();

/** Write the tree now. Writes are serialized so an older, slower save can never
 *  overwrite a newer one (task launches flush before and after each step). */
export function flushPersistence(): Promise<void> {
  clearTimeout(timer);
  const { repos, selection, settings, queues, recentRepos, tasks } =
    useAppStore.getState();
  const tree: PersistedTree = {
    schemaVersion: 1,
    repos,
    selection,
    settings,
    queues,
    recentRepos,
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

/** Debounced (300ms) write of the tree on any persisted-field change. */
export function startPersistence() {
  if (started) return;
  started = true;
  useAppStore.subscribe((s, prev) => {
    if (!s.hydrated) return;
    if (
      s.repos === prev.repos &&
      s.selection === prev.selection &&
      s.settings === prev.settings &&
      s.queues === prev.queues &&
      s.recentRepos === prev.recentRepos &&
      s.tasks === prev.tasks
    ) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flushPersistence().catch((e) => console.error("Could not save workspace", e));
    }, 300);
  });
}
