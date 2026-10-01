// Claude's headless stream-json (what the cloud agent writes) as ACP session
// updates, so cloud turns render through the same transcript as local ones.
import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import type { AcpTranscriptItem } from "./acpTranscript";

type Json = Record<string, unknown>;

const KINDS: Record<string, ToolKind> = {
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
  Grep: "search",
  Glob: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  TodoWrite: "think",
  Task: "think",
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

function toolTitle(name: string, input: Json): string {
  const target =
    str(input.command) ||
    str(input.file_path) ||
    str(input.notebook_path) ||
    str(input.pattern) ||
    str(input.url) ||
    str(input.query) ||
    str(input.description);
  return target ? `${name} ${target}` : name;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" ? str((part as Json).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** One stream-json line as zero or more session updates. `key` makes message
 *  ids unique per event, so text blocks never merge across tool calls. */
export function streamLineUpdates(line: string, key: string): SessionUpdate[] {
  let event: Json;
  try {
    event = JSON.parse(line) as Json;
  } catch {
    return [];
  }
  const message = (event.message ?? {}) as Json;
  const blocks = Array.isArray(message.content) ? (message.content as Json[]) : [];
  const id = `${str(event.uuid) || key}`;
  const updates: SessionUpdate[] = [];
  if (event.type === "assistant") {
    blocks.forEach((block, index) => {
      const messageId = `cloud-${id}-${index}`;
      if (block.type === "text" && str(block.text)) {
        updates.push({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: str(block.text) } });
      } else if (block.type === "thinking" && str(block.thinking)) {
        updates.push({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: str(block.thinking) } });
      } else if (block.type === "tool_use") {
        const name = str(block.name) || "tool";
        const input = (block.input ?? {}) as Json;
        const path = str(input.file_path);
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId: str(block.id) || messageId,
          title: toolTitle(name, input),
          kind: KINDS[name] ?? "other",
          status: "in_progress",
          rawInput: input,
          ...(path ? { locations: [{ path }] } : {}),
        });
      }
    });
  } else if (event.type === "user") {
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const text = resultText(block.content);
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: str(block.tool_use_id),
        status: block.is_error ? "failed" : "completed",
        ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
      });
    }
  }
  return updates;
}

/**
 * The chat as plain text for the cloud agent: what was asked and answered,
 * newest last, capped from the front so the latest context always fits. Tool
 * calls are left out; the branch carries their effects.
 */
export function handoffText(items: AcpTranscriptItem[], maxChars = 60_000): string {
  const turns: string[] = [];
  for (const item of items) {
    if (item.type !== "message" || !item.text.trim()) continue;
    if (item.role === "user") turns.push(`## User\n${item.text.trim()}`);
    else if (item.role === "assistant") turns.push(`## Assistant\n${item.text.trim()}`);
  }
  if (turns.length === 0) return "";
  let body = turns.join("\n\n");
  if (body.length > maxChars) body = `[earlier conversation trimmed]\n\n${body.slice(body.length - maxChars)}`;
  return `The conversation so far:\n\n${body}\n\nContinue from where the conversation left off.`;
}
