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
let timer: number | undefined;

/** Debounced (300ms) write of the tree on any persisted-field change. */
export function startPersistence() {
  if (started) return;
  started = true;
  useAppStore.subscribe((s, prev) => {
    if (!s.hydrated) return;
    if (
      s.repos === prev.repos &&
      s.selection === prev.selection &&
      s.settings === prev.settings
    ) {
      return;
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const { repos, selection, settings } = useAppStore.getState();
      const store = await getStore();
      await store.set("tree", { repos, selection, settings } satisfies PersistedTree);
      await store.save();
    }, 300);
  });
}
