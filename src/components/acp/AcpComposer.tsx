import { useEffect, useLayoutEffect, useRef } from "react";

interface Props {
  active: boolean;
  busy: boolean;
  agentName: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: (prompt: string) => void;
  onOpenCommands: () => void;
  thinkingLevel?: string;
}

export function AcpComposer({
  active,
  busy,
  agentName,
  draft,
  onDraftChange,
  onSubmit,
  onOpenCommands,
  thinkingLevel,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!active || busy) return;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(draft.length, draft.length);
  }, [active, busy]);

  // Grow with the draft; CSS max-height caps it at 7 lines, then it scrolls.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);

  return (
    <form
      className="shrink-0 bg-background px-3 pt-2 font-mono"
      onSubmit={(event) => {
        event.preventDefault();
        const prompt = draft.trim();
        if (!prompt || busy) return;
        onSubmit(prompt);
      }}
    >
      <div
        data-thinking={thinkingLevel}
        data-busy={busy}
        className="pi-editor flex min-h-14 items-start gap-2 border bg-card px-2 py-2"
      >
        <span className="pt-1 text-accent-brand" aria-hidden>
          &gt;
        </span>
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          aria-label="Message agent"
          placeholder={busy ? `${agentName} is working…` : "Type a message, /command, or @file"}
          disabled={busy}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "/" && !busy && draft.length === 0) {
              event.preventDefault();
              onOpenCommands();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="max-h-[148px] min-h-9 flex-1 overflow-y-auto resize-none bg-transparent py-1 text-sm leading-5 outline-none placeholder:text-muted-foreground/60 disabled:opacity-60"
        />
      </div>
      <p className="mt-1 px-1 text-[10px] text-muted-foreground/60">
        enter send · shift+enter newline · shift+tab mode · esc interrupt · ⌘⇧P commands
      </p>
    </form>
  );
}
