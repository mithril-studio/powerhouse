// Run checkpoint: the host-side write path.
//
// At the end of a working turn Powerhouse distils one note from the session so
// what a run did is not lost when nobody thinks to call write_note. The note
// lands in the inbox as a `session` summary — raw material a human curates into
// a real gotcha or decision, or discards. It is deliberately low-value on its
// own; the value is that nothing is dropped.
//
// The distiller is pure and unit-tested; the write is a thin memoryCall.

import type { AcpTranscriptItem } from "./acpTranscript";
import { INBOX_DIR, memoryCall, type MemorySettings } from "./memory";

type ToolItem = Extract<AcpTranscriptItem, { type: "tool" }>;
type MessageItem = Extract<AcpTranscriptItem, { type: "message" }>;

export interface CheckpointInput {
  transcript: AcpTranscriptItem[];
  /** Stable per-session key, so a session's note overwrites itself each turn
   *  rather than piling up one note per turn. */
  key: string;
  branch: string;
  agent: string;
  at: Date;
}

export interface Checkpoint {
  title: string;
  body: string;
}

/** The `session` note_type is not one of the ranked kinds, so a checkpoint
 *  stays out of briefs until a human retypes it into a real note on approval. */
export const CHECKPOINT_TYPE = "session";

const MAX_FILES = 15;
const MAX_COMMANDS = 12;

const oneLine = (text: string, max = 120): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const isTool = (i: AcpTranscriptItem): i is ToolItem => i.type === "tool";
const isMessage = (i: AcpTranscriptItem): i is MessageItem => i.type === "message";

/** The command a shell/execute tool ran, from its structured input or title. */
function commandOf(tool: ToolItem): string {
  const input = tool.rawInput;
  if (input && typeof input === "object") {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === "string" && command.trim()) return oneLine(command, 100);
  }
  return oneLine(tool.title, 100);
}

/**
 * Build one inbox note summarising a finished session, or null when the run was
 * too thin to be worth recording. A run counts as substantive only once a tool
 * actually touched the repo; pure question-and-answer chats hold no repo
 * knowledge and are skipped.
 */
export function distillCheckpoint(input: CheckpointInput): Checkpoint | null {
  const { transcript } = input;
  const tools = transcript.filter(isTool);
  if (tools.length === 0) return null;

  const messages = transcript.filter(isMessage);
  const task = messages.find((m) => m.role === "user" && m.text.trim())?.text ?? "";
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.text.trim());

  const files: string[] = [];
  for (const tool of tools) {
    for (const location of tool.locations ?? []) {
      if (location.path && !files.includes(location.path)) files.push(location.path);
    }
  }

  const commands: string[] = [];
  for (const tool of tools) {
    if (tool.kind !== "execute") continue;
    const command = commandOf(tool);
    if (command && !commands.includes(command)) commands.push(command);
  }

  const shownFiles = files.slice(0, MAX_FILES);
  const shownCommands = commands.slice(0, MAX_COMMANDS);

  const lines: string[] = [];
  if (task) lines.push(`- [task] ${oneLine(task)}`);
  if (shownFiles.length > 0) {
    const more = files.length > shownFiles.length ? ` (+${files.length - shownFiles.length} more)` : "";
    lines.push(`- [files] ${shownFiles.join(", ")}${more}`);
  }
  if (shownCommands.length > 0) lines.push(`- [commands] ${shownCommands.join(" · ")}`);
  if (lastAssistant) lines.push(`- [outcome] ${oneLine(lastAssistant.text, 200)}`);
  lines.push(
    `- [session] ${input.agent} on ${input.branch}; ${tools.length} tool call${tools.length === 1 ? "" : "s"}; ${input.at.toISOString()}`,
  );

  const stamp = input.at.toISOString().slice(0, 16).replace("T", " ");
  const subject = task ? oneLine(task, 60) : `${shownFiles[0] ?? "work"}`;
  return {
    title: `Session ${stamp}: ${subject} [${input.key}]`,
    body: lines.join("\n"),
  };
}

/** Write (or overwrite) a session checkpoint into the project's inbox. */
export const writeCheckpoint = (memory: MemorySettings, project: string, cp: Checkpoint) =>
  memoryCall(memory, "write_note", {
    project,
    title: cp.title,
    content: cp.body,
    directory: INBOX_DIR,
    note_type: CHECKPOINT_TYPE,
    overwrite: true,
  });
