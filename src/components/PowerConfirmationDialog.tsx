import { useEffect, useSyncExternalStore } from "react";
import {
  getPowerConfirmation,
  settlePowerConfirmation,
  subscribePowerConfirmation,
} from "../lib/powerConfirm";
import { Dialog, Kbd } from "./ui/dialog";

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
    <Dialog
      title={confirmation.title}
      onClose={() => settlePowerConfirmation(false)}
      describedBy="power-confirmation-message"
    >
      <div className="ph-dialog-body pt-2">
        <p
          id="power-confirmation-message"
          className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]"
        >
          {confirmation.message}
        </p>
      </div>
      <footer className="ph-dialog-foot">
        <button
          type="button"
          onClick={() => settlePowerConfirmation(false)}
          className="ph-btn ph-btn-ghost"
        >
          {confirmation.cancelLabel} <Kbd>esc</Kbd>
        </button>
        <button
          type="button"
          onClick={() => settlePowerConfirmation(true)}
          className="ph-btn ph-btn-danger"
        >
          {confirmation.confirmLabel} <Kbd>{confirmation.shortcutLabel}</Kbd>
        </button>
      </footer>
    </Dialog>
  );
}
