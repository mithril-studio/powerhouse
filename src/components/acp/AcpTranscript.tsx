import { useEffect, useRef } from "react";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { AcpTranscriptItem } from "../../lib/acpTranscript";
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

function ToolItem({ item }: { item: Extract<AcpTranscriptItem, { type: "tool" }> }) {
  const details = Boolean(
    item.content?.length ||
      item.locations?.length ||
      item.rawInput !== undefined ||
      item.rawOutput !== undefined,
  );
  const header = (
    <>
      <span
        className={
          item.status === "failed"
            ? "text-destructive"
            : item.status === "in_progress"
              ? "text-accent-brand"
              : "text-muted-foreground"
        }
        aria-hidden
      >
        {statusGlyph[item.status ?? "pending"] ?? "·"}
      </span>
      <span className="truncate text-xs text-foreground/90">{item.title}</span>
      {item.kind && (
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
          {item.kind}
        </span>
      )}
    </>
  );

  if (!details) {
    return <div className="flex items-center gap-2 py-0.5">{header}</div>;
  }
  return (
    <details className="group py-0.5">
      <summary className="flex cursor-default list-none items-center gap-2 outline-none focus-visible:bg-muted">
        {header}
      </summary>
      <div className="ml-1 mt-1 space-y-2 border-l border-border py-1 pl-4">
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
}

function TranscriptItem({ item }: { item: AcpTranscriptItem }) {
  if (item.type === "tool") return <ToolItem item={item} />;
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
        <p className="mt-2 whitespace-pre-wrap border-l border-border pl-3">{item.text}</p>
      </details>
    );
  }
  if (item.role === "user") {
    return (
      <article className="flex gap-2 bg-muted/60 px-2 py-2">
        <span className="shrink-0 text-accent-brand" aria-hidden>&gt;</span>
        <p className="select-text whitespace-pre-wrap break-words">{item.text}</p>
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
      <p className="select-text whitespace-pre-wrap break-words leading-5">{item.text}</p>
    </article>
  );
}

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
        {items.map((item) => (
          <TranscriptItem key={item.id} item={item} />
        ))}
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
