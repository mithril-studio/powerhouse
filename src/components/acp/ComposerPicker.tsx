import { useEffect, useRef, useState } from "react";
import type { ApplyOp, Selector } from "../../lib/agentControls";
import { CheckIcon, ChevronDownIcon } from "../ui/icons";

/**
 * A quiet dropdown in the composer toolbar (model, reasoning level). Opens
 * upward because the composer sits at the bottom of the window.
 */
export function ComposerPicker({
  selector,
  disabled,
  title,
  onApply,
  footer,
}: {
  selector: Selector;
  disabled?: boolean;
  title?: string;
  onApply: (op: ApplyOp) => void;
  /** Extra action under the options, e.g. "All agent commands". */
  footer?: { label: string; hint?: string; onSelect: () => void };
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const label = selector.current?.label ?? selector.title;
  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${selector.title}: ${label}`}
        title={title ?? selector.title}
        onClick={() => setOpen((value) => !value)}
        className="composer-picker"
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </button>
      {open && (
        <div role="menu" aria-label={selector.title} className="ph-menu composer-menu">
          <p className="composer-menu-heading">{selector.title}</p>
          {selector.options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.active}
              title={option.description}
              onClick={() => {
                if (!option.active) onApply(option.apply);
                setOpen(false);
              }}
            >
              <span className="truncate">{option.label}</span>
              {option.active && <CheckIcon className="size-3.5 text-foreground" />}
            </button>
          ))}
          {footer && (
            <>
              <hr className="composer-menu-rule" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  footer.onSelect();
                }}
              >
                <span className="truncate">{footer.label}</span>
                {footer.hint && <span className="ph-kbd">{footer.hint}</span>}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
