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

  const canSubmit = !busy && (draft.trim().length > 0 || attachments.length > 0);

  return (
    <form
      className="shrink-0 bg-background px-3 pt-2 font-mono"
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
        className="pi-editor flex min-h-14 flex-col gap-2 border bg-card px-2 py-2 data-[dragging=true]:border-accent-brand"
      >
        <div className="flex items-start gap-2">
          <span className="pt-1 text-accent-brand" aria-hidden>
            &gt;
          </span>
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            aria-label="Message agent"
            placeholder={
              busy
                ? `${agentName} is working…`
                : dragging
                  ? "Drop images to attach"
                  : "Type a message, /command, or @file"
            }
            disabled={busy}
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
      </div>
      <p className="mt-1 px-1 text-[10px] text-muted-foreground/60">
        enter send · shift+enter newline · shift+tab mode · esc interrupt · ⌘⇧P commands
        {supportsImages ? " · paste, drop, or + for images" : ""}
      </p>
    </form>
  );
}
