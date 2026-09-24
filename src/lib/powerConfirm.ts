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
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribePowerConfirmation(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPowerConfirmation(): PowerConfirmation | null {
  if (!pending) return null;
  const { resolve: _resolve, ...confirmation } = pending;
  return confirmation;
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
    pending = {
      id: nextId++,
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? "Delete",
      cancelLabel: options.cancelLabel ?? "Cancel",
      shortcutLabel: options.shortcutLabel ?? "⌘W",
      resolve,
    };
    emit();
  });
}

export function settlePowerConfirmation(confirmed: boolean) {
  const current = pending;
  if (!current) return;
  pending = null;
  emit();
  current.resolve(confirmed);
}
