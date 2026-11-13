import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

interface Props {
  active: boolean;
  busy: boolean;
  agentName: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: (prompt: string) => void;
  onOpenCommands: () => void;
  onCancel: () => void;
  thinkingLevel?: string;
  controls?: ReactNode;
}

export function AcpComposer({ active, busy, agentName, draft, onDraftChange, onSubmit, onOpenCommands, onCancel, thinkingLevel, controls }: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !active) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  }, [draft, active]);

  return (
    <form className="chat-composer shrink-0 px-6 pt-3" onSubmit={(event) => {
      event.preventDefault();
      const prompt = draft.trim();
      if (prompt && !busy) onSubmit(prompt);
    }}>
      <div className="chat-column composer-surface" data-busy={busy}>
        <textarea
          ref={inputRef}
          value={draft}
          rows={2}
          aria-label="Message agent"
          placeholder={busy ? "Draft a follow-up while the agent works…" : "Ask a question or describe a task…"}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "/" && !busy && draft.length === 0) {
              event.preventDefault();
              onOpenCommands();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="block max-h-60 min-h-16 w-full resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground"
        />
        <div className="composer-toolbar">
          <button type="button" onClick={onOpenCommands} disabled={busy} aria-label="Agent commands" title="Agent commands (⌘⇧P)" className="composer-agent">
            {agentName} {!controls && thinkingLevel && <span className="text-muted-foreground">· {thinkingLevel}</span>} <span aria-hidden>⌄</span>
          </button>
          {controls}
          <span className="flex-1" />
          {/* Distinct keys prevent Stop becoming a submit button during its click. */}
          {busy ? (
            <button key="stop" type="button" onClick={onCancel} className="composer-send" aria-label="Stop agent" title="Stop agent (Esc)"><span aria-hidden>■</span></button>
          ) : (
            <button key="send" type="submit" disabled={!draft.trim()} className="composer-send composer-send-primary" aria-label="Send message" title="Send message (Enter)"><span aria-hidden>↑</span></button>
          )}
        </div>
      </div>
      <p className="chat-column mt-2 text-center text-[11px] text-muted-foreground">{busy ? "Draft your next message while the agent works · Esc to stop" : "Enter to send · Shift+Enter for a new line · / for commands"}</p>
    </form>
  );
}
