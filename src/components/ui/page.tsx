import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, PlusIcon } from "./icons";

/**
 * The app's page structure: a title on the left, controls on the right, and a
 * hairline underneath. Every top-level view (board, Mission Control, settings)
 * uses this so they read as one app.
 */
export function PageHeader({
  title,
  children,
  className = "",
}: {
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header data-tauri-drag-region className={`ph-page-header ${className}`}>
      <h1 className="ph-page-title">{title}</h1>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </header>
  );
}

/** Native select dressed as a quiet control (keeps keyboard + a11y for free). */
export function SelectControl({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <span className="ph-select">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="size-3.5" />
    </span>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div role="group" aria-label={label} className="ph-segmented">
      {options.map((o) => (
        <button key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/** Popover menu anchored to its trigger. Closes on outside click and Escape. */
export function Menu({
  trigger,
  label,
  items,
  align = "end",
  triggerClassName,
}: {
  trigger: ReactNode;
  label: string;
  items: (MenuItem | "separator")[];
  align?: "start" | "end";
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative flex">
      <button
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClassName}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div role="menu" className={`ph-menu ${align === "end" ? "right-0" : "left-0"}`}>
          {items.length === 0 && <p className="px-2.5 py-1.5 text-muted-foreground">Nothing here yet</p>}
          {items.map((item, i) =>
            item === "separator" ? (
              <div key={`sep-${i}`} role="separator" className="my-1 border-t border-border" />
            ) : (
              <button
                key={item.label}
                role="menuitem"
                disabled={item.disabled}
                className={item.destructive ? "text-destructive" : undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Primary action with a secondary menu fused to its right edge. */
export function SplitButton({
  label,
  onClick,
  disabled,
  menuLabel,
  items,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  menuLabel: string;
  items: (MenuItem | "separator")[];
}) {
  return (
    <div className="ph-split">
      <button className="ph-split-main" disabled={disabled} onClick={onClick}>
        <PlusIcon className="size-4" />
        {label}
      </button>
      <Menu
        label={menuLabel}
        items={items}
        triggerClassName="ph-split-more"
        trigger={<ChevronDownIcon className="size-4" />}
      />
    </div>
  );
}
