import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterPalette,
  flattenView,
  type PaletteItem,
  type PaletteView,
} from "../../lib/acpCommandPalette";
import type { ApplyOp } from "../../lib/agentControls";
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon } from "../ui/icons";

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
      aria-modal="true"
      aria-label="Agent command palette"
      className="chat-palette shrink-0 px-6 pt-1"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          goBack();
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
      <div className="chat-column composer-surface">
      <div className="chat-palette-search">
        {stack.length > 1 && (
          <button type="button" onClick={goBack} aria-label="Back" className="ph-icon-btn size-6">
            <ArrowLeftIcon className="size-3.5" />
          </button>
        )}
        {current.title && <span className="shrink-0 font-medium">{current.title}</span>}
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          aria-label="Filter commands"
          placeholder={
            current.title
              ? `Search ${current.title.toLowerCase()}…`
              : "Search commands, skills, model, mode…"
          }
          className="h-full flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        />
        <kbd className="ph-kbd">esc</kbd>
      </div>
      <div role="listbox" className="chat-palette-list">
        {filtered.groups.map((group) =>
          group.items.map((item) => {
            const index = items.indexOf(item);
            const showGroup = group.heading !== previousGroup;
            previousGroup = group.heading;
            const isSubmenu = item.action.type === "submenu";
            return (
              <div key={item.id}>
                {showGroup && !current.title && (
                  <p className="chat-palette-heading">
                    {group.heading}
                  </p>
                )}
                <button
                  ref={index === activeIndex ? activeOptionRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseMove={(event) => hoverIndex(index, event)}
                  onClick={() => choose(item)}
                  className="chat-palette-item"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{item.label}</span>
                    {item.description && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                  </span>
                  {item.hint && (
                    <span className="ph-kbd shrink-0">{item.hint}</span>
                  )}
                  {item.selected && <CheckIcon className="size-3.5 text-foreground" />}
                  {isSubmenu && <ChevronRightIcon className="size-3.5 text-muted-foreground" />}
                </button>
              </div>
            );
          }),
        )}
        {items.length === 0 && (
          <p className="px-2 py-6 text-center text-muted-foreground">
            No matching commands
          </p>
        )}
      </div>
      </div>
    </section>
  );
}
