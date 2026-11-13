import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  filterPalette,
  flattenView,
  type PaletteItem,
  type PaletteView,
} from "../../lib/acpCommandPalette";
import type { ApplyOp } from "../../lib/agentControls";

interface Props {
  view: PaletteView;
  onApply: (op: ApplyOp) => void;
  onInsert: (prompt: string) => void;
  onNativeCli: () => void;
  onRestart: () => void;
  onClose: () => void;
}

export function AcpCommandPalette({
  view,
  onApply,
  onInsert,
  onNativeCli,
  onRestart,
  onClose,
}: Props) {
  const listId = useId();
  // A stack of drilled-into views; index 0 is the (live) root.
  const [stack, setStack] = useState<PaletteView[]>([view]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  // Last real pointer position. Arrowing the list calls scrollIntoView, which
  // slides items under a stationary cursor and fires mouse events at the SAME
  // coordinates — ignore those so hover never fights keyboard navigation.
  const pointerRef = useRef({ x: -1, y: -1 });

  const hoverIndex = (index: number, event: { clientX: number; clientY: number }) => {
    if (event.clientX === pointerRef.current.x && event.clientY === pointerRef.current.y) {
      return;
    }
    pointerRef.current = { x: event.clientX, y: event.clientY };
    setActiveIndex(index);
  };

  // Keep the root fresh as the agent streams commands/config, but never yank the
  // user out of a submenu they've drilled into.
  useEffect(() => {
    setStack((current) => (current.length === 1 ? [view] : current));
  }, [view]);

  const current = stack[stack.length - 1];
  const filtered = useMemo(
    () => filterPalette(current, query),
    [current, query],
  );
  const items = useMemo(() => flattenView(filtered), [filtered]);

  useEffect(() => inputRef.current?.focus(), [stack.length]);
  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(Math.max(0, items.length - 1));
  }, [activeIndex, items.length]);
  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const goBack = () => {
    if (stack.length > 1) {
      setStack((current) => current.slice(0, -1));
      setQuery("");
      setActiveIndex(0);
    } else {
      onClose();
    }
  };

  const choose = (item: PaletteItem) => {
    const { action } = item;
    switch (action.type) {
      case "submenu":
        setStack((current) => [...current, action.view]);
        setQuery("");
        setActiveIndex(0);
        return;
      case "apply":
        onApply(action.op);
        onClose();
        return;
      case "insert_prompt":
        onInsert(action.prompt);
        onClose();
        return;
      case "native_cli":
        onNativeCli();
        onClose();
        return;
      case "restart":
        onRestart();
        onClose();
        return;
    }
  };

  let previousGroup = "";
  return (
    <section
      role="dialog"
      aria-label="Agent command palette"
      className="command-popover"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          goBack();
        } else if (event.target !== inputRef.current) {
          return;
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          if (items.length === 0) return;
          setActiveIndex((index) => Math.min(index + 1, items.length - 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          if (items.length === 0) return;
          setActiveIndex((index) => Math.max(0, index - 1));
        } else if (event.key === "Enter" && items[activeIndex]) {
          event.preventDefault();
          choose(items[activeIndex]);
        } else if (event.key === "Tab") {
          event.preventDefault();
          setActiveIndex((index) =>
            items.length === 0
              ? 0
              : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length,
          );
        }
      }}
    >
      <div className="flex h-11 shrink-0 items-center border-b border-border px-3 text-sm">
        {stack.length > 1 && (
          <button
            type="button"
            onClick={goBack}
            aria-label="Back"
            className="mr-2 text-muted-foreground hover:text-foreground"
          >
            ‹
          </button>
        )}
        <span className="mr-2 text-accent-brand" aria-hidden>
          {current.title ? current.title : ">"}
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          aria-label="Filter commands"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          placeholder={
            current.title
              ? `Search ${current.title.toLowerCase()}…`
              : "commands, skills, model, mode…"
          }
          className="h-full flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        <button type="button" onClick={onClose} aria-label="Close commands" className="ml-2 text-xs text-muted-foreground">Esc</button>
      </div>
      <div role="listbox" id={listId} aria-label="Commands" className="min-h-0 overflow-y-auto p-1.5">
        {filtered.groups.map((group) =>
          group.items.map((item) => {
            const index = items.indexOf(item);
            const showGroup = group.heading !== previousGroup;
            previousGroup = group.heading;
            const isSubmenu = item.action.type === "submenu";
            return (
              <div key={item.id}>
                {showGroup && !current.title && (
                  <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                    {group.heading}
                  </p>
                )}
                <button
                  ref={index === activeIndex ? activeOptionRef : undefined}
                  type="button"
                  role="option"
                  id={`${listId}-${index}`}
                  aria-selected={index === activeIndex}
                  onMouseMove={(event) => hoverIndex(index, event)}
                  onClick={() => choose(item)}
                  className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-xs ${
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
                  {item.hint && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {item.hint}
                    </span>
                  )}
                  {isSubmenu && (
                    <span className="shrink-0 text-muted-foreground" aria-hidden>
                      ›
                    </span>
                  )}
                </button>
              </div>
            );
          }),
        )}
        {items.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No matching commands
          </p>
        )}
      </div>
    </section>
  );
}
