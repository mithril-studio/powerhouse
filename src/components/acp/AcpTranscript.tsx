import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { AcpTranscriptItem } from "../../lib/acpTranscript";
import {
  groupTools,
  summarizeTools,
  toolLabel,
  toolVerb,
  type ToolGroup,
  type ToolTranscriptItem,
} from "../../lib/toolDisplay";
import { attachmentData, formatBytes, type AttachmentRef } from "../../lib/attachments";
import { ChatImage } from "./ChatImage";
import { AcpMarkdown } from "./AcpMarkdown";
import { ContextUsageMeter } from "./ContextUsageMeter";
import { ArrowDownIcon, CheckIcon, ChevronRightIcon, CloseIcon, ImageIcon } from "../ui/icons";

/** Context-window reading at the end of a turn: how full the model's memory is. */
function UsageItem({ item }: { item: Extract<AcpTranscriptItem, { type: "usage" }> }) {
  return (
    <p role="status" className="chat-usage">
      <ContextUsageMeter
        used={item.used}
        size={item.size}
        cost={item.cost}
        label="context"
      />
    </p>
  );
}

/** Tool and plan-step status as an icon: hollow ring, live dot, check, or cross. */
function StatusIcon({ status }: { status?: string | null }) {
  if (status === "completed") return <CheckIcon className="chat-status size-3.5 text-muted-foreground" />;
  if (status === "failed") return <CloseIcon className="chat-status size-3.5 text-destructive" />;
  return (
    <span className="chat-status grid size-3.5 place-items-center" aria-hidden>
      <span className={status === "in_progress" ? "chat-status-live" : "chat-status-pending"} />
    </span>
  );
}

function readableValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolContent({ item }: { item: ToolCallContent }) {
  if (item.type === "content") {
    if (item.content.type === "image") return <ChatImage mimeType={item.content.mimeType} data={item.content.data} />;
    return item.content.type === "text" ? (
      <pre className="chat-tool-output">
        {item.content.text}
      </pre>
    ) : (
      <p className="text-xs text-muted-foreground">{item.content.type} output</p>
    );
  }
  if (item.type === "diff") {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{item.path}</p>
        <pre className="chat-tool-output chat-tool-diff">
          {item.newText}
        </pre>
      </div>
    );
  }
  return <p className="text-xs text-muted-foreground">Terminal {item.terminalId}</p>;
}

const ToolRow = memo(function ToolRow({ item }: { item: ToolTranscriptItem }) {
  const details = Boolean(
    item.content?.length ||
      item.locations?.length ||
      item.rawInput !== undefined ||
      item.rawOutput !== undefined,
  );
  const label = toolLabel(item);
  const header = (
    <>
      <StatusIcon status={item.status} />
      <span className="chat-tool-verb">{toolVerb(item.kind)}</span>
      <span
        className={`min-w-0 truncate ${item.status === "failed" ? "text-destructive" : "text-foreground/85"}`}
        title={item.title}
      >
        {label || item.title}
      </span>
    </>
  );

  if (!details) {
    return <div className="chat-tool-row">{header}</div>;
  }
  return (
    <details className="chat-tool">
      <summary className="chat-tool-row">
        {header}
      </summary>
      <div className="chat-tool-details">
        {item.title !== label && (
          <pre className="chat-tool-output text-foreground/85">
            {item.title}
          </pre>
        )}
        {item.locations?.map((location) => (
          <p key={`${location.path}:${location.line ?? ""}`} className="text-muted-foreground">
            {location.path}{location.line ? `:${location.line}` : ""}
          </p>
        ))}
        {item.content?.filter((content) => !(content.type === "content" && content.content.type === "image")).map((content, index) => (
          <ToolContent key={index} item={content} />
        ))}
        {item.rawInput !== undefined && (
          <pre className="chat-tool-output">
            {readableValue(item.rawInput)}
          </pre>
        )}
        {item.rawOutput !== undefined && (
          <pre className="chat-tool-output">
            {readableValue(item.rawOutput)}
          </pre>
        )}
      </div>
    </details>
  );
});

/** Consecutive tool calls as one line — "14 tool calls  9 run · 3 read" —
 *  expandable to the full list. While running, the live call shows under it. */
function ToolGroupItem({ group }: { group: ToolGroup }) {
  const [open, setOpen] = useState(false);
  const { tools } = group;
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const active = [...tools]
    .reverse()
    .find((tool) => tool.status === "in_progress" || tool.status === "pending");
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="chat-tool-row chat-disclosure w-full text-left"
      >
        <ChevronRightIcon className="chat-chevron size-3.5" />
        <span className="shrink-0 text-foreground/85">{tools.length} tool calls</span>
        <span className="min-w-0 truncate">{summarizeTools(tools)}</span>
        {failed > 0 && <span className="shrink-0 text-destructive">{failed} failed</span>}
      </button>
      {tools.flatMap((tool) => (tool.content ?? []).filter((content) => content.type === "content" && content.content.type === "image").map((content, index) => (
        <ToolContent key={`${tool.id}-${index}`} item={content} />
      )))}
      {open ? (
        <div className="chat-tool-group">
          {tools.map((tool) => (
            <ToolRow key={tool.id} item={tool} />
          ))}
        </div>
      ) : (
        active && (
          <div className="chat-tool-group">
            <ToolRow item={active} />
          </div>
        )
      )}
    </div>
  );
}

/** Thumbnails for images sent or received; a labelled chip once the bytes are
 *  gone (they are runtime-only, never persisted). */
function Attachments({ items }: { items?: AttachmentRef[] }) {
  if (!items?.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Images">
      {items.map((ref) => {
        const data = attachmentData(ref.id);
        return (
          <li key={ref.id} className="text-xs text-muted-foreground">
            {data ? (
              <ChatImage mimeType={ref.mimeType} data={data} />
            ) : (
              <span className="chat-chip">
                <ImageIcon className="size-3.5" /> {ref.name} · {formatBytes(ref.bytes)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Memoised so a streaming chunk re-renders only the message it lands in, not
// every markdown block above it.
const TranscriptItem = memo(function TranscriptItem({ item }: { item: AcpTranscriptItem }) {
  if (item.type === "tool") return <>
    <ToolRow item={item} />
    {item.content?.filter((content) => content.type === "content" && content.content.type === "image").map((content, index) => <ToolContent key={index} item={content} />)}
  </>;
  if (item.type === "usage") return <UsageItem item={item} />;
  if (item.type === "plan") {
    return (
      <section className="chat-plan" aria-label="Agent plan">
        <p className="chat-plan-title">Plan</p>
        <ol className="space-y-1.5">
          {item.entries.map((entry, index) => (
            <li key={`${index}-${entry.content}`} className="flex items-start gap-2.5">
              <span className="mt-[3px]"><StatusIcon status={entry.status} /></span>
              <span className={entry.status === "completed" ? "text-muted-foreground line-through" : ""}>
                {entry.content}
              </span>
            </li>
          ))}
        </ol>
      </section>
    );
  }
  if (item.role === "thought") {
    return (
      <details className="chat-thought">
        <summary className="chat-tool-row chat-disclosure">
          <ChevronRightIcon className="chat-chevron size-3.5" />
          Thinking
        </summary>
        <AcpMarkdown text={item.text} className="chat-thought-body" />
      </details>
    );
  }
  if (item.role === "user") {
    return (
      <article aria-label="Your message" className="chat-user">
        <div className="min-w-0 flex-1">
          {item.text && (
            <p className="select-text whitespace-pre-wrap break-words">{item.text}</p>
          )}
          <Attachments items={item.attachments} />
        </div>
      </article>
    );
  }
  if (item.role === "system") {
    return (
      <p
        role={item.tone === "error" ? "alert" : "status"}
        className={`chat-notice ${item.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {item.text}
      </p>
    );
  }
  return (
    <article>
      <AcpMarkdown text={item.text} />
      <Attachments items={item.attachments} />
    </article>
  );
});

export function AcpTranscript({
  items,
  busy,
  agentName,
  commandCount,
}: {
  items: AcpTranscriptItem[];
  busy: boolean;
  agentName: string;
  commandCount: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const entries = useMemo(() => groupTools(items), [items]);

  useEffect(() => {
    if (followRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, busy]);

  return (
    <div className="relative min-h-0 flex-1">
    <div
      ref={scrollRef}
      role="log"
      aria-live="polite"
      aria-label="Chat transcript"
      onLoad={() => {
        if (followRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        setShowLatest(!followRef.current);
      }}
      className="h-full overflow-y-auto px-6 py-8"
    >
      <div className="chat-column flex min-h-full flex-col gap-5">
        {items.length === 0 && (
          <div className="chat-empty" role="status">
            <p className="chat-empty-title">Start a conversation with {agentName}</p>
            <p>
              Ask a question or describe a task. Type <kbd className="ph-kbd">/</kbd> for
              commands and skills{commandCount > 0 ? ` (${commandCount} from the agent)` : ""}.
            </p>
          </div>
        )}
        {entries.map((entry) =>
          entry.type === "tool-group" ? (
            <ToolGroupItem key={entry.id} group={entry} />
          ) : (
            <TranscriptItem key={entry.id} item={entry} />
          ),
        )}
        {busy && (
          <p className="chat-working" role="status">
            <span className="chat-working-dots" aria-hidden><i /><i /><i /></span>
            Working
          </p>
        )}
      </div>
    </div>
    {showLatest && <button type="button" className="jump-latest ph-btn" onClick={() => {
      followRef.current = true;
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      setShowLatest(false);
    }}><ArrowDownIcon className="size-3.5" /> Jump to latest</button>}
    </div>
  );
}
