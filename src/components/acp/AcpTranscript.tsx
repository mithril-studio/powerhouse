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
import { CloudResultCard } from "../CloudResultCard";
import { dataUrl, formatBytes, type AttachmentRef } from "../../lib/attachments";
import { AcpMarkdown } from "./AcpMarkdown";
import { ContextUsageMeter } from "./ContextUsageMeter";

/** Context-window reading at the end of a turn: how full the model's memory is. */
function UsageItem({ item }: { item: Extract<AcpTranscriptItem, { type: "usage" }> }) {
  return (
    <p role="status" className="flex justify-end text-[10px]">
      <ContextUsageMeter
        used={item.used}
        size={item.size}
        cost={item.cost}
        label="context"
      />
    </p>
  );
}

const statusGlyph: Record<string, string> = {
  pending: "·",
  in_progress: "●",
  completed: "✓",
  failed: "×",
};

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
    return item.content.type === "text" ? (
      <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
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
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-l border-border bg-card py-1 pl-3 text-xs">
          {item.newText}
        </pre>
      </div>
    );
  }
  return <p className="text-xs text-muted-foreground">Terminal {item.terminalId}</p>;
}

const glyphTone = (status: ToolTranscriptItem["status"]) =>
  status === "failed"
    ? "text-destructive"
    : status === "in_progress"
      ? "text-accent-brand"
      : "text-muted-foreground/70";

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
      <span className={`w-3 shrink-0 text-center ${glyphTone(item.status)}`} aria-hidden>
        {statusGlyph[item.status ?? "pending"] ?? "·"}
      </span>
      <span className="w-12 shrink-0 text-muted-foreground/70">{toolVerb(item.kind)}</span>
      <span
        className={`min-w-0 truncate ${item.status === "failed" ? "text-destructive" : "text-foreground/80"}`}
        title={item.title}
      >
        {label || item.title}
      </span>
    </>
  );

  if (!details) {
    return <div className="flex items-center gap-2 text-xs leading-5">{header}</div>;
  }
  return (
    <details className="group text-xs leading-5">
      <summary className="flex cursor-default list-none items-center gap-2 outline-none hover:bg-muted/50 focus-visible:bg-muted">
        {header}
      </summary>
      <div className="mb-1 ml-1.5 mt-0.5 space-y-2 border-l border-border py-1 pl-4">
        {item.title !== label && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-foreground/80">
            {item.title}
          </pre>
        )}
        {item.locations?.map((location) => (
          <p key={`${location.path}:${location.line ?? ""}`} className="text-xs text-muted-foreground">
            {location.path}{location.line ? `:${location.line}` : ""}
          </p>
        ))}
        {item.content?.map((content, index) => (
          <ToolContent key={index} item={content} />
        ))}
        {item.rawInput !== undefined && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {readableValue(item.rawInput)}
          </pre>
        )}
        {item.rawOutput !== undefined && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {readableValue(item.rawOutput)}
          </pre>
        )}
      </div>
    </details>
  );
});

/** Consecutive tool calls as one line — "▸ 14 tool calls · 9 run · 3 read" —
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
        className="flex w-full items-center gap-2 text-left text-xs leading-5 text-muted-foreground outline-none hover:text-foreground focus-visible:bg-muted"
      >
        <span className={`w-3 shrink-0 text-center ${active ? "text-accent-brand" : ""}`} aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="shrink-0 text-foreground/80">{tools.length} tool calls</span>
        <span className="min-w-0 truncate text-muted-foreground/70">{summarizeTools(tools)}</span>
        {failed > 0 && <span className="shrink-0 text-destructive">{failed} failed</span>}
      </button>
      {open ? (
        <div className="ml-1.5 border-l border-border pl-3">
          {tools.map((tool) => (
            <ToolRow key={tool.id} item={tool} />
          ))}
        </div>
      ) : (
        active && (
          <div className="ml-1.5 border-l border-border pl-3">
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
        const src = dataUrl(ref);
        return (
          <li key={ref.id} className="text-[11px] text-muted-foreground">
            {src ? (
              <img
                src={src}
                alt={ref.name}
                title={`${ref.name} · ${formatBytes(ref.bytes)}`}
                className="max-h-48 max-w-72 border border-border object-contain"
              />
            ) : (
              <span className="inline-flex items-center gap-1 border border-border px-1.5 py-0.5">
                ▣ {ref.name} · {formatBytes(ref.bytes)}
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
  if (item.type === "tool") return <ToolRow item={item} />;
  if (item.type === "cloud-result") return <CloudResultCard runId={item.runId} late={item.late} />;
  if (item.type === "usage") return <UsageItem item={item} />;
  if (item.type === "plan") {
    return (
      <section className="border-l border-accent-brand/40 pl-3" aria-label="Agent plan">
        <p className="mb-1 text-xs text-accent-brand">
          ◇ plan
        </p>
        <ol className="space-y-1">
          {item.entries.map((entry, index) => (
            <li key={`${index}-${entry.content}`} className="flex gap-2 text-xs">
              <span className={entry.status === "completed" ? "text-success" : "text-muted-foreground"}>
                {statusGlyph[entry.status]}
              </span>
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
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-default outline-none focus-visible:bg-muted">
          ◇ thinking
        </summary>
        <AcpMarkdown text={item.text} className="mt-2 border-l border-border pl-3" />
      </details>
    );
  }
  if (item.role === "user") {
    return (
      <article className="flex gap-2 bg-muted/60 px-2 py-2">
        <span className="shrink-0 text-accent-brand" aria-hidden>&gt;</span>
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
        className={`border-l py-0.5 pl-3 text-xs ${
          item.tone === "error"
            ? "border-destructive text-destructive"
            : "border-border text-muted-foreground"
        }`}
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
  branchName,
  commandCount,
}: {
  items: AcpTranscriptItem[];
  busy: boolean;
  agentName: string;
  branchName: string;
  commandCount: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const entries = useMemo(() => groupTools(items), [items]);

  useEffect(() => {
    if (followRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, busy]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="polite"
      aria-label="Chat transcript"
      onScroll={(event) => {
        const element = event.currentTarget;
        followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
    >
      <div className="flex w-full flex-col gap-3 text-[13px]">
        {items.length === 0 && (
          <div className="py-8" role="status">
            <p className="text-sm text-accent-brand">Powerhouse / {agentName}</p>
            <p className="mt-1 text-xs text-muted-foreground">{branchName}</p>
            <p className="mt-4 text-xs text-muted-foreground">
              ⌘⇧P commands{commandCount > 0 ? ` · ${commandCount} from agent` : ""}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Type <span className="text-foreground">/</span> for agent commands and skills.
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
          <p className="flex items-center gap-2 text-xs text-accent-brand" role="status">
            <span className="animate-pulse">●</span>
            working…
          </p>
        )}
      </div>
    </div>
  );
}
