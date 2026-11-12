import { useEffect, useLayoutEffect, useRef } from "react";
import { dataUrl, formatBytes, type Attachment } from "../../lib/attachments";

interface Props {
  active: boolean;
  busy: boolean;
  agentName: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: (prompt: string) => void;
  onOpenCommands: () => void;
  onCancel?: () => void;
  thinkingLevel?: string;
  /** Images queued for the next prompt (empty when the agent lacks support). */
  attachments: Attachment[];
  supportsImages: boolean;
  dragging: boolean;
  onPasteFiles: (files: File[]) => void;
  onPickFiles: () => void;
  onRemoveAttachment: (id: string) => void;
}

export function AcpComposer({
  active,
  busy,
  agentName,
  draft,
  onDraftChange,
  onSubmit,
  onOpenCommands,
  onCancel,
  thinkingLevel,
  attachments,
  supportsImages,
  dragging,
  onPasteFiles,
  onPickFiles,
  onRemoveAttachment,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  // Grow with the draft; CSS max-height caps it at 7 lines, then it scrolls.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !active) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft, active]);

  const canSubmit = !busy && (draft.trim().length > 0 || attachments.length > 0);

  return (
    <form
      className="chat-composer shrink-0 px-6 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        onSubmit(draft.trim());
      }}
    >
      <div
        data-thinking={thinkingLevel}
        data-busy={busy}
        data-dragging={dragging}
        className="chat-column composer-surface flex flex-col gap-2 data-[dragging=true]:border-accent-brand"
      >
        <div className="flex items-start gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            rows={3}
            aria-label="Message agent"
            placeholder={
              busy
                ? "Draft a follow-up while the agent works…"
                : dragging
                  ? "Drop images to attach"
                  : "Ask a question or describe a task…"
            }
            onChange={(event) => onDraftChange(event.target.value)}
            onPaste={(event) => {
              const { clipboardData } = event;
              const files = Array.from(clipboardData.files);
              if (files.length === 0) {
                for (const item of Array.from(clipboardData.items)) {
                  const file = item.kind === "file" ? item.getAsFile() : null;
                  if (file) files.push(file);
                }
              }
              if (files.length === 0) return;
              event.preventDefault();
              onPasteFiles(files);
            }}
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
            className="max-h-60 min-h-20 flex-1 overflow-y-auto resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground"
          />
          {supportsImages && (
            <button
              type="button"
              onClick={onPickFiles}
              disabled={busy}
              title="Attach images (or paste / drop them)"
              aria-label="Attach images"
              className="pi-btn h-7 w-7 shrink-0 text-sm"
            >
              +
            </button>
          )}
        </div>
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2 pl-4" aria-label="Attached images">
            {attachments.map((attachment) => {
              const src = dataUrl(attachment);
              return (
                <li
                  key={attachment.id}
                  className="flex items-center gap-2 border border-border bg-background px-1.5 py-1 text-[11px] text-muted-foreground"
                >
                  {src ? (
                    <img
                      src={src}
                      alt={attachment.name}
                      className="h-8 w-8 border border-border object-cover"
                    />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center border border-border">
                      ▣
                    </span>
                  )}
                  <span className="max-w-40 truncate text-foreground/90">{attachment.name}</span>
                  <span>{formatBytes(attachment.bytes)}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    aria-label={`Remove ${attachment.name}`}
                    className="pi-btn h-5 w-5 text-xs"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-2 flex items-center gap-3">
          <button type="button" onClick={onOpenCommands} disabled={busy} aria-label="Agent commands" className="composer-agent">
            {agentName} {thinkingLevel && <span className="text-muted-foreground">· {thinkingLevel}</span>} <span aria-hidden>⌄</span>
          </button>
          <span className="flex-1" />
          {/* Distinct keys keep Stop from becoming submit during its click. */}
          {busy ? (onCancel && <button key="stop" type="button" onClick={onCancel} className="pi-btn h-8 px-3" aria-label="Stop agent">■ Stop</button>) : (
            <button key="send" type="submit" disabled={!canSubmit} className="pi-btn pi-btn-primary h-8 px-3" aria-label="Send message">Send ↑</button>
          )}
        </div>
      </div>
      <p className="chat-column mt-2 text-xs text-muted-foreground">{busy ? "Draft your next message while the agent works" : "Enter to send · Shift+Enter for a new line · / for commands"}</p>
    </form>
  );
}
