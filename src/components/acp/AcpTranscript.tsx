import { useEffect, useRef, useState } from "react";
import type { AcpTranscriptItem } from "../../lib/acpTranscript";
import { ChatImage } from "./ChatImage";
import { ChatMarkdown } from "./ChatMarkdown";
import { CopyButton } from "./CopyButton";
import { ToolActivity } from "./ToolActivity";

const statusGlyph: Record<string, string> = {
  pending: "·",
  in_progress: "●",
  completed: "✓",
  failed: "×",
};

function TranscriptItem({ item }: { item: AcpTranscriptItem }) {
  if (item.type === "image") return <ChatImage mimeType={item.mimeType} data={item.data} />;
  if (item.type === "tool") return <ToolActivity items={[item]} />;
  if (item.type === "plan") {
    return (
      <section className="agent-plan" aria-label="Agent plan">
        <p className="mb-3 text-xs font-medium text-foreground">
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
      <details className="agent-thought text-xs text-muted-foreground">
        <summary className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Thinking
        </summary>
        <div className="mt-3 border-l border-border pl-4"><ChatMarkdown text={item.text} /></div>
      </details>
    );
  }
  if (item.role === "user") {
    return (
      <article aria-label="Your message" className="chat-user">
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
    <article aria-label="Agent response" className="agent-response group">
      <ChatMarkdown text={item.text} />
      <div className="response-actions"><CopyButton text={item.text} label="Copy response" /></div>
    </article>
  );
}

/** Keep each message in order and compact only adjacent tool calls. */
function transcriptBlocks(items: AcpTranscriptItem[]): AcpTranscriptItem[][] {
  const blocks: AcpTranscriptItem[][] = [];
  for (const item of items) {
    const previous = blocks[blocks.length - 1];
    if (item.type === "tool" && previous?.[0].type === "tool") previous.push(item);
    else blocks.push([item]);
  }
  return blocks;
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
  const [showLatest, setShowLatest] = useState(false);

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
      className="transcript-scroll h-full overflow-y-auto px-6 py-8"
    >
      <div className="chat-column flex flex-col gap-5">
        {items.length === 0 && (
          <div className="chat-welcome" role="status">
            <div className="agent-mark" aria-hidden="true">✳</div>
            <h2>What are we building?</h2>
            <p>Ask {agentName} to explore, build, or fix something in your project.</p>
            <span className="chat-context">⑂ {branchName}</span>
            <p className="text-xs">Type / for commands{commandCount > 0 ? ` · ${commandCount} available` : ""}</p>
          </div>
        )}
        {transcriptBlocks(items).map((block, index, blocks) => {
          const first = block[0];
          const previous = blocks[index - 1]?.[0];
          const isAgent = first.type === "tool" || first.type === "plan" || (first.type === "image" && first.role !== "user") || (first.type === "message" && first.role !== "user" && first.role !== "system");
          const startsTurn = isAgent && (!previous || (previous.type === "message" && previous.role === "user") || (previous.type === "image" && previous.role === "user"));
          return <div key={first.id} className={first.type === "message" && first.role === "user" ? "chat-user-row" : ""}>
            {startsTurn && <div className="agent-turn-label"><span className="agent-mark" aria-hidden="true">✳</span>{agentName}</div>}
            {first.type === "tool" ? <ToolActivity items={block.filter((item): item is Extract<AcpTranscriptItem, { type: "tool" }> => item.type === "tool")} /> : <TranscriptItem item={first} />}
          </div>;
        })}
        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <span className="animate-pulse">●</span>
            {agentName} is working…
          </p>
        )}
      </div>
    </div>
    {showLatest && <button type="button" className="jump-latest pi-btn" onClick={() => {
      followRef.current = true;
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      setShowLatest(false);
    }}>↓ Jump to latest</button>}
    </div>
  );
}
