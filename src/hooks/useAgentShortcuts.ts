import { useEffect } from "react";

interface Params {
  /** Only bind while this pane is the visible, connected one. */
  active: boolean;
  ready: boolean;
  busy: boolean;
  paletteOpen: boolean;
  /** ⌘⇧P — open/close every capability for the current agent. */
  onTogglePalette: () => void;
  /** Esc while the agent is working (and no palette is open). */
  onCancel: () => void;
  /** Shift+Tab — cycle the agent's advertised interaction mode. */
  onCycleMode: () => void;
}

/**
 * Maps raw keyboard events to agent intents. Keeping this separate from the
 * connection and the view means shortcuts can be reasoned about (and the intent
 * routing tested) without a live agent or the DOM tree of the chat.
 */
export function useAgentShortcuts({
  active,
  ready,
  busy,
  paletteOpen,
  onTogglePalette,
  onCancel,
  onCycleMode,
}: Params) {
  useEffect(() => {
    if (!active || !ready) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        event.stopPropagation();
        onTogglePalette();
      } else if (
        event.key === "Tab" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !paletteOpen
      ) {
        event.preventDefault();
        event.stopPropagation();
        onCycleMode();
      } else if (event.key === "Escape") {
        // While the palette is open it owns Escape (pop submenu, then close), so
        // the global handler stays out of the way.
        if (!paletteOpen && busy) {
          event.preventDefault();
          onCancel();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    active,
    ready,
    busy,
    paletteOpen,
    onTogglePalette,
    onCancel,
    onCycleMode,
  ]);
}
