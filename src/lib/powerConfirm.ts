export interface PowerConfirmation {
  id: number;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  shortcutLabel: string;
}

interface PendingConfirmation extends PowerConfirmation {
  resolve: (confirmed: boolean) => void;
}

let nextId = 1;
let pending: PendingConfirmation | null = null;
// Snapshot for useSyncExternalStore: must stay reference-equal between emits,
// or React re-renders forever and unmounts the whole tree on "maximum update
// depth exceeded" (the app goes blank the moment a confirmation opens).
let snapshot: PowerConfirmation | null = null;
const listeners = new Set<() => void>();

function setPending(next: PendingConfirmation | null) {
  pending = next;
  snapshot = next
    ? {
        id: next.id,
        title: next.title,
        message: next.message,
        confirmLabel: next.confirmLabel,
        cancelLabel: next.cancelLabel,
        shortcutLabel: next.shortcutLabel,
      }
    : null;
  for (const listener of listeners) listener();
}

export function subscribePowerConfirmation(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPowerConfirmation(): PowerConfirmation | null {
  return snapshot;
}

export function hasPowerConfirmation() {
  return pending !== null;
}

export function requestPowerConfirmation(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  shortcutLabel?: string;
}): Promise<boolean> {
  if (pending) return Promise.resolve(false);

  return new Promise((resolve) => {
    setPending({
      id: nextId++,
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? "Delete",
      cancelLabel: options.cancelLabel ?? "Cancel",
      shortcutLabel: options.shortcutLabel ?? "⌘W",
      resolve,
    });
  });
}

export function settlePowerConfirmation(confirmed: boolean) {
  const current = pending;
  if (!current) return;
  setPending(null);
  current.resolve(confirmed);
}
