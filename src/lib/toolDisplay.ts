import type { ToolKind } from "@agentclientprotocol/sdk";
import type { AcpTranscriptItem } from "./acpTranscript";

export type ToolTranscriptItem = Extract<AcpTranscriptItem, { type: "tool" }>;

/** A run of consecutive tool calls, rendered as one collapsible line. */
export interface ToolGroup {
  id: string;
  type: "tool-group";
  tools: ToolTranscriptItem[];
}

export type TranscriptEntry = AcpTranscriptItem | ToolGroup;

/** Fold consecutive tool calls into groups. A lone tool call stays as-is. */
export function groupTools(items: AcpTranscriptItem[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let run: ToolTranscriptItem[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) out.push({ id: `group-${run[0].id}`, type: "tool-group", tools: run });
    run = [];
  };
  for (const item of items) {
    if (item.type === "tool") run.push(item);
    else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

const verbs: Record<ToolKind, string> = {
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "search",
  execute: "run",
  think: "think",
  fetch: "fetch",
  switch_mode: "mode",
  other: "tool",
};

export function toolVerb(kind: ToolKind | null | undefined): string {
  return verbs[kind ?? "other"] ?? "tool";
}

/** Shorten absolute paths: home → `~`, and a Powerhouse worktree root → nothing. */
export function shortenPaths(text: string): string {
  return text
    .replace(/\/(?:private\/)?(?:Users|home)\/[^/\s"']+\/\.powerhouse\/worktrees\/[^/\s"']+\/[^/\s"']+\/?/g, "")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "~");
}

/**
 * The part of a shell command worth reading at a glance: drops a leading
 * `cd <dir> &&`, leading `VAR=value` assignments, and heredoc bodies, and keeps
 * only the first line.
 */
export function compactCommand(command: string): string {
  let text = command.trim();
  // Heredoc body and everything after it: keep only the line that opens it.
  text = text.split("\n")[0];
  text = text.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, "");
  while (/^[A-Z_][A-Z0-9_]*=("[^"]*"|'[^']*'|\S+)\s+/.test(text)) {
    text = text.replace(/^[A-Z_][A-Z0-9_]*=("[^"]*"|'[^']*'|\S+)\s+/, "");
  }
  return shortenPaths(text.replace(/\s+/g, " ").trim());
}

/** One-line label for a tool call, cleaned for display. */
export function toolLabel(tool: ToolTranscriptItem): string {
  const input = tool.rawInput;
  if (tool.kind === "execute") {
    const command =
      input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
    return compactCommand(typeof command === "string" && command.trim() ? command : tool.title);
  }
  // Titles like "Read /abs/path" already carry the verb; drop it, the verb column shows it.
  const title = tool.title.replace(/^(Read|Write|Edit|Delete|Move|Search|Fetch)\s+/i, "");
  return shortenPaths(title.split("\n")[0].trim());
}

/** "12 run · 3 read · 1 edit", most frequent first. */
export function summarizeTools(tools: ToolTranscriptItem[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const verb = toolVerb(tool.kind);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([verb, count]) => `${count} ${verb}`)
    .join(" · ");
}
