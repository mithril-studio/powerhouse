import { useEffect, useRef, useState } from "react";

interface Props {
  active: boolean;
  busy: boolean;
  agentName: string;
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
}

export function AcpComposer({ active, busy, agentName, onSubmit, onCancel }: Props) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (active && !busy) inputRef.current?.focus();
  }, [active, busy]);

  return (
    <form
      className="border-t border-border bg-background px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        const prompt = draft.trim();
        if (!prompt || busy) return;
        setDraft("");
        onSubmit(prompt);
      }}
    >
      <div className="mx-auto flex max-w-4xl items-end gap-2 rounded-lg border border-input bg-card p-2 focus-within:border-ring/60">
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          aria-label="Message agent"
          placeholder={busy ? "Agent is working…" : `Message ${agentName}`}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!draft.trim()}
            className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            Send
          </button>
        )}
      </div>
      <p className="mx-auto mt-1.5 max-w-4xl text-[10px] text-muted-foreground/60">
        Enter to send · Shift+Enter for a new line
      </p>
    </form>
  );
}
