import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { CloseIcon } from "./icons";

const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex='-1'])";

/**
 * The one modal shell: dimmed backdrop, card panel near the top of the window,
 * title with a close button. Bodies and footers use `.ph-dialog-body` and
 * `.ph-dialog-foot`. Escape, backdrop click and × close it unless `busy`;
 * focus stays inside while open and returns to where it was on close.
 */
export function Dialog({
  title,
  onClose,
  busy = false,
  width = "28rem",
  describedBy,
  onKeyDown,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  width?: string;
  describedBy?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // Children may autofocus a field; otherwise take focus so keys reach us.
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    const trap = (event: globalThis.KeyboardEvent) => {
      const panel = panelRef.current;
      if (event.key !== "Tab" || !panel) return;
      const elements = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) return;
      const inside = panel.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => {
      document.removeEventListener("keydown", trap, true);
      if (before?.isConnected) before.focus();
    };
  }, []);

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <div
      className="ph-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        className="ph-dialog"
        style={{ width: `min(100%, ${width})` }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <header className="ph-dialog-head">
          <h2 id={titleId} className="ph-dialog-title">
            {title}
          </h2>
          <button
            type="button"
            className="ph-icon-btn"
            onClick={close}
            disabled={busy}
            aria-label={`Close ${title}`}
          >
            <CloseIcon className="size-3.5" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

/** Keyboard shortcut shown inside a button, e.g. <Kbd>⌘↵</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="ph-kbd" aria-hidden="true">
      {children}
    </kbd>
  );
}
