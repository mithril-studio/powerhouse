import { useEffect, useLayoutEffect, useRef } from "react";
import { dataUrl, formatBytes, type Attachment } from "../../lib/attachments";
import type { ApplyOp, Selector, Unsupported } from "../../lib/agentControls";
import { ArrowUpIcon, ChevronDownIcon, CloseIcon, ImageIcon, PlusIcon, StopIcon } from "../ui/icons";
import { ComposerPicker } from "./ComposerPicker";

interface Props {
  active: boolean;
  busy: boolean;
  agentName: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: (prompt: string) => void;
  onOpenCommands: () => void;
  onCancel?: () => void;
  /** Model and reasoning pickers; omitted or unsupported when the agent doesn't advertise them. */
  models?: Selector | Unsupported;
  reasoning?: Selector | Unsupported;
  onApply?: (op: ApplyOp) => void;
  /** Images queued for the next prompt (empty when the agent lacks support). */
  attachments: Attachment[];
  supportsImages: boolean;
  dragging: boolean;
  onPasteFiles: (files: File[]) => void;
  onPickFiles: () => void;
  onRemoveAttachment: (id: string) => void;
}

/**
 * T3-style composer: the message on top, one toolbar underneath — attach on
 * the left; model, reasoning and Send/Stop on the right.
 */
export function AcpComposer({
  active,
  busy,
  agentName,
  draft,
  onDraftChange,
  onSubmit,
  onOpenCommands,
  onCancel,
  models,
  reasoning,
  onApply = () => {},
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

  // Grow with the draft; CSS max-height caps it, then it scrolls.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !active) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft, active]);

  const canSubmit = !busy && (draft.trim().length > 0 || attachments.length > 0);
  const commands = { label: "All agent commands", hint: "/", onSelect: onOpenCommands };

  return (
    <form
      className="chat-composer shrink-0 px-6 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        onSubmit(draft.trim());
      }}
    >
      <div
        data-busy={busy}
        data-dragging={dragging}
        className="chat-column composer-surface"
      >
        {attachments.length > 0 && (
          <ul className="composer-attachments" aria-label="Attached images">
            {attachments.map((attachment) => {
              const src = dataUrl(attachment);
              return (
                <li key={attachment.id} className="composer-attachment">
                  {src ? (
                    <img src={src} alt={attachment.name} />
                  ) : (
                    <span className="composer-attachment-placeholder">
                      <ImageIcon className="size-4" />
                    </span>
                  )}
                  <span className="max-w-40 truncate text-foreground">{attachment.name}</span>
                  <span>{formatBytes(attachment.bytes)}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    aria-label={`Remove ${attachment.name}`}
                    className="ph-icon-btn size-5"
                  >
                    <CloseIcon className="size-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <textarea
          ref={inputRef}
          value={draft}
          rows={2}
          aria-label="Message agent"
          placeholder={
            busy
              ? "Draft a follow-up while the agent works…"
              : dragging
                ? "Drop images to attach"
                : "Ask anything, or type / for commands"
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
          className="composer-input"
        />
        <div className="composer-toolbar">
          <button
            type="button"
            onClick={onPickFiles}
            disabled={busy || !supportsImages}
            title={supportsImages ? "Attach images (or paste / drop them)" : `${agentName} doesn't accept images`}
            aria-label="Attach images"
            className="composer-icon-btn"
          >
            <PlusIcon />
          </button>
          <span className="flex-1" />
          {models?.supported ? (
            <ComposerPicker
              selector={models}
              disabled={busy}
              title={`${agentName} model`}
              onApply={onApply}
              footer={commands}
            />
          ) : (
            <button
              type="button"
              onClick={onOpenCommands}
              disabled={busy}
              aria-label="Agent commands"
              title="Agent commands (/)"
              className="composer-picker"
            >
              <span className="truncate">{agentName}</span>
              <ChevronDownIcon className="size-3.5 opacity-60" />
            </button>
          )}
          {reasoning?.supported && (
            <>
              <span className="composer-divider" aria-hidden />
              <ComposerPicker selector={reasoning} disabled={busy} onApply={onApply} />
            </>
          )}
          {/* Distinct keys keep Stop from becoming submit during its click. */}
          {busy ? (
            onCancel && (
              <button key="stop" type="button" onClick={onCancel} className="composer-send" aria-label="Stop agent" title="Stop agent (Esc)">
                <StopIcon />
              </button>
            )
          ) : (
            <button key="send" type="submit" disabled={!canSubmit} className="composer-send composer-send-primary" aria-label="Send message" title="Send (Enter)">
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
