import { useEffect, useRef } from "react";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { AcpTranscriptItem } from "../../lib/acpTranscript";

const statusGlyph: Record<string, string> = {
  pending: "○",
  in_progress: "◌",
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
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
        {item.content.text}
      </pre>
    ) : (
      <p className="text-xs text-muted-foreground">{item.content.type} output</p>
    );
  }
  if (item.type === "diff") {
    return (
      <div className="space-y-2">
        <p className="font-mono text-xs text-muted-foreground">{item.path}</p>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-xs">
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
        className={item.status === "failed" ? "text-destructive" : "text-muted-foreground"}
        aria-hidden
      >
        {statusGlyph[item.status ?? "pending"] ?? "○"}
      </span>
      <span className="truncate text-xs text-foreground/90">{item.title}</span>
      {item.kind && (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {item.kind}
        </span>
      )}
    </>
  );

  if (!details) {
    return <div className="flex items-center gap-2 border-l border-border py-1 pl-3">{header}</div>;
  }
  return (
    <details className="group border-l border-border py-1 pl-3">
      <summary className="flex cursor-default list-none items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
        {header}
      </summary>
      <div className="mt-2 space-y-2 border-l border-border pl-3">
        {item.locations?.map((location) => (
          <p key={`${location.path}:${location.line ?? ""}`} className="font-mono text-xs text-muted-foreground">
            {location.path}{location.line ? `:${location.line}` : ""}
          </p>
        ))}
        {item.content?.map((content, index) => (
          <ToolContent key={index} item={content} />
        ))}
        {item.rawInput !== undefined && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {readableValue(item.rawInput)}
          </pre>
        )}
        {item.rawOutput !== undefined && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {readableValue(item.rawOutput)}
          </pre>
        )}
      </div>
    </details>
  );
}

function TranscriptItem({ item }: { item: AcpTranscriptItem }) {
  if (item.type === "tool") return <ToolItem item={item} />;
  if (item.type === "plan") {
    return (
      <section className="border-l border-accent-brand/40 pl-3" aria-label="Agent plan">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Plan
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
        <summary className="cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
          Reasoning
        </summary>
        <p className="mt-2 whitespace-pre-wrap border-l border-border pl-3">{item.text}</p>
      </details>
    );
  }
  if (item.role === "user") {
    return (
      <div className="ml-auto max-w-[80%] rounded-lg bg-muted px-3 py-2">
        <p className="select-text whitespace-pre-wrap break-words">{item.text}</p>
      </div>
    );
  }
  if (item.role === "system") {
    return (
      <p
        role={item.tone === "error" ? "alert" : "status"}
        className={`border-l pl-3 text-xs ${
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
    <article className="max-w-3xl">
      <p className="select-text whitespace-pre-wrap break-words leading-6">{item.text}</p>
    </article>
  );
}

export function AcpTranscript({
  items,
  busy,
}: {
  items: AcpTranscriptItem[];
  busy: boolean;
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
      className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        {items.length === 0 && (
          <div className="py-16 text-center" role="status">
            <p className="text-sm text-muted-foreground">Describe what you want to build or change.</p>
          </div>
        )}
        {items.map((item) => (
          <TranscriptItem key={item.id} item={item} />
        ))}
        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <span className="size-1.5 animate-pulse rounded-full bg-accent-brand" />
            Working…
          </p>
        )}
      </div>
    </div>
  );
}
