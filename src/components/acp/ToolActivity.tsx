import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { AcpTranscriptItem } from "../../lib/acpTranscript";
import { ChatImage } from "./ChatImage";
import { CopyButton } from "./CopyButton";

export type ToolItem = Extract<AcpTranscriptItem, { type: "tool" }>;
const states = {
  pending: { label: "Queued", glyph: "·", color: "text-muted-foreground" },
  in_progress: { label: "Running", glyph: "◌", color: "text-accent-brand" },
  completed: { label: "Done", glyph: "✓", color: "text-success" },
  failed: { label: "Failed", glyph: "×", color: "text-destructive" },
};

function readable(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? ""; } catch { return String(value); }
}

function ToolOutput({ item }: { item: ToolCallContent }) {
  if (item.type === "content") {
    if (item.content.type === "image") return <ChatImage mimeType={item.content.mimeType} data={item.content.data} />;
    return item.content.type === "text"
      ? <pre className="tool-output">{item.content.text}</pre>
      : <p className="text-xs text-muted-foreground">{item.content.type} output</p>;
  }
  if (item.type === "diff") {
    return <div className="tool-edit">
      <div className="code-toolbar"><span className="truncate font-mono" title={item.path}>{item.path}</span></div>
      {item.oldText != null && <div><p className="tool-edit-label text-destructive">Before</p><pre className="tool-output bg-destructive/5">{item.oldText}</pre></div>}
      <div><p className="tool-edit-label text-success">{item.oldText == null ? "New file" : "After"}</p><pre className="tool-output bg-success/5">{item.newText}</pre></div>
    </div>;
  }
  return <p className="text-xs text-muted-foreground">Terminal {item.terminalId}</p>;
}

function RawData({ label, value }: { label: string; value: unknown }) {
  const text = readable(value);
  return <details className="tool-raw">
    <summary>{label}</summary>
    <div className="flex justify-end"><CopyButton text={text} label={`Copy ${label.toLowerCase()}`} /></div>
    <pre className="tool-output">{text}</pre>
  </details>;
}

function ToolCard({ item }: { item: ToolItem }) {
  const state = states[item.status ?? "pending"];
  const content = item.content?.filter((part) => !(part.type === "content" && part.content.type === "image")) ?? [];
  const hasDetails = content.length > 0 || !!item.locations?.length || item.rawInput !== undefined || item.rawOutput !== undefined;
  const header = <>
    <span className={`tool-state ${state.color}`} aria-hidden="true">{state.glyph}</span>
    <span className="min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
    <span className={`shrink-0 text-[11px] ${state.color}`}>{state.label}</span>
  </>;
  if (!hasDetails) return <div className="tool-card-header">{header}</div>;
  return <details className="tool-card">
    <summary className="tool-card-header"><span className="tool-chevron" aria-hidden="true">›</span>{header}</summary>
    <div className="tool-card-body">
      {item.locations?.map((location) => <p key={`${location.path}:${location.line ?? ""}`} className="break-all font-mono text-[11px] text-muted-foreground">{location.path}{location.line != null ? `:${location.line}` : ""}</p>)}
      {content.map((part, i) => <ToolOutput key={i} item={part} />)}
      {item.rawInput !== undefined && <RawData label="Input" value={item.rawInput} />}
      {item.rawOutput !== undefined && <RawData label="Output" value={item.rawOutput} />}
    </div>
  </details>;
}

/** Collapse consecutive calls as one activity block; keep image results visible. */
export function ToolActivity({ items }: { items: ToolItem[] }) {
  const running = items.filter((item) => item.status === "in_progress").length;
  const failed = items.filter((item) => item.status === "failed").length;
  return <div className="chat-tool">
    {items.length === 1 ? <ToolCard item={items[0]} /> : <details className="tool-group">
      <summary className="tool-card-header">
        <span className="tool-chevron" aria-hidden="true">›</span>
        <span className="flex-1">{items.length} tool calls</span>
        {running > 0 && <span className="text-accent-brand">{running} running</span>}
        {failed > 0 && <span className="text-destructive">{failed} failed</span>}
        {!running && !failed && <span className="text-muted-foreground">View activity</span>}
      </summary>
      <div className="tool-group-body">{items.map((item) => <ToolCard key={item.id} item={item} />)}</div>
    </details>}
    {items.flatMap((item) => (item.content ?? []).map((part, i) => part.type === "content" && part.content.type === "image" ? <ToolOutput key={`${item.id}:${i}`} item={part} /> : null))}
  </div>;
}
