import { useEffect, useSyncExternalStore } from "react";
import {
  getPowerConfirmation,
  settlePowerConfirmation,
  subscribePowerConfirmation,
} from "../lib/powerConfirm";

export function PowerConfirmationDialog() {
  const confirmation = useSyncExternalStore(
    subscribePowerConfirmation,
    getPowerConfirmation,
    getPowerConfirmation,
  );

  useEffect(() => {
    if (!confirmation) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settlePowerConfirmation(false);
        return;
      }

      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "w"
      ) {
        event.preventDefault();
        event.stopPropagation();
        settlePowerConfirmation(true);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [confirmation]);

  if (!confirmation) return null;

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-background/60 pt-32">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="power-confirmation-title"
        aria-describedby="power-confirmation-message"
        className="w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-card p-4 font-mono shadow-xl"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-accent-brand" aria-hidden>
            !
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="power-confirmation-title" className="text-sm font-semibold text-foreground">
              {confirmation.title}
            </h2>
            <p
              id="power-confirmation-message"
              className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground"
            >
              {confirmation.message}
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              Press <kbd className="rounded border border-border bg-background px-1 py-0.5 text-foreground">{confirmation.shortcutLabel}</kbd> to delete, or Escape to cancel.
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => settlePowerConfirmation(false)}
            className="h-8 rounded-lg border border-border px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {confirmation.cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => settlePowerConfirmation(true)}
            className="h-8 rounded-lg border border-destructive px-3 text-xs text-destructive hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {confirmation.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
