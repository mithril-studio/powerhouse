import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterAcpPaletteItems,
  type AcpPaletteItem,
} from "../../lib/acpCommandPalette";

interface Props {
  items: AcpPaletteItem[];
  onChoose: (item: AcpPaletteItem) => void;
  onClose: () => void;
}

export function AcpCommandPalette({ items, onChoose, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const filtered = useMemo(
    () => filterAcpPaletteItems(items, query),
    [items, query],
  );

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [activeIndex, filtered.length]);
  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  let previousGroup = "";
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="Agent command palette"
      className="shrink-0 border-t border-border bg-background px-3 pt-2 font-mono"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          if (filtered.length === 0) return;
          setActiveIndex((index) =>
            Math.min(index + 1, filtered.length - 1),
          );
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          if (filtered.length === 0) return;
          setActiveIndex((index) => Math.max(0, index - 1));
        } else if (event.key === "Enter" && filtered[activeIndex]) {
          event.preventDefault();
          onChoose(filtered[activeIndex]);
        } else if (event.key === "Tab") {
          event.preventDefault();
          setActiveIndex((index) =>
            filtered.length === 0
              ? 0
              : (index + (event.shiftKey ? -1 : 1) + filtered.length) %
                filtered.length,
          );
        }
      }}
    >
      <div className="flex h-9 items-center border border-accent-brand/70 bg-card px-2 text-sm">
        <span className="mr-2 text-accent-brand" aria-hidden>
          &gt;
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          aria-label="Filter commands"
          placeholder="commands, skills, model, mode…"
          className="h-full flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        <kbd className="text-[10px] text-muted-foreground">esc</kbd>
      </div>
      <div role="listbox" className="max-h-64 overflow-y-auto py-1.5">
        {filtered.map((item, index) => {
          const showGroup = item.group !== previousGroup;
          previousGroup = item.group;
          return (
            <div key={item.id}>
              {showGroup && (
                <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                  {item.group}
                </p>
              )}
              <button
                ref={index === activeIndex ? activeOptionRef : undefined}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onChoose(item)}
                className={`flex w-full items-start gap-3 px-2 py-1.5 text-left text-xs ${
                  index === activeIndex
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                <span className="w-3 shrink-0 text-accent-brand" aria-hidden>
                  {item.selected ? "✓" : index === activeIndex ? "›" : ""}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">{item.label}</span>
                  {item.description && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {item.description}
                    </span>
                  )}
                </span>
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No matching commands
          </p>
        )}
      </div>
    </section>
  );
}
