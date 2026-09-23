import type {
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { registerAttachment, type AttachmentRef } from "./attachments";

export type AcpMessageRole = "user" | "assistant" | "thought" | "system";

export type AcpTranscriptItem =
  | {
      id: string;
      type: "message";
      role: AcpMessageRole;
      text: string;
      messageId?: string;
      tone?: "normal" | "error";
      /** Images sent with (user) or returned in (assistant) this message. */
      attachments?: AttachmentRef[];
    }
  | {
      id: string;
      type: "tool";
      toolCallId: string;
      title: string;
      kind?: ToolKind | null;
      status?: ToolCallStatus | null;
      content?: ToolCallContent[] | null;
      locations?: ToolCallLocation[] | null;
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | {
      id: "plan";
      type: "plan";
      entries: PlanEntry[];
    }
  | {
      /** `cloud-result-<runId>` — the run id is the dedupe key across restarts. */
      id: string;
      type: "cloud-result";
      runId: string;
      /** True when appended at boot for a run that had already finished. */
      late: boolean;
    };

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** Append the cloud-result card for a run once. The run id keys the dedupe, so
 *  replayed record updates and restarts never double-post. */
export function appendCloudResult(
  transcript: AcpTranscriptItem[],
  runId: string,
  late: boolean,
): AcpTranscriptItem[] {
  if (transcript.some((item) => item.type === "cloud-result" && item.runId === runId)) {
    return transcript;
  }
  return [...transcript, { id: `cloud-result-${runId}`, type: "cloud-result", runId, late }];
}

export function appendUserMessage(
  transcript: AcpTranscriptItem[],
  text: string,
  attachments: AttachmentRef[] = [],
): AcpTranscriptItem[] {
  return [
    ...transcript,
    {
      id: newId("user"),
      type: "message",
      role: "user",
      text,
      ...(attachments.length ? { attachments } : {}),
    },
  ];
}

export function appendSystemMessage(
  transcript: AcpTranscriptItem[],
  text: string,
  tone: "normal" | "error" = "normal",
): AcpTranscriptItem[] {
  return [
    ...transcript,
    { id: newId("system"), type: "message", role: "system", text, tone },
  ];
}

type Chunk =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; uri?: string | null };

function toChunk(content: ContentBlock): Chunk | null {
  if (content.type === "text") return content.text ? content : null;
  if (content.type === "image") return content;
  return null;
}

/** Merges a streamed chunk into the open message of the same role, or opens one. */
function appendChunk(
  transcript: AcpTranscriptItem[],
  role: "user" | "assistant" | "thought",
  chunk: Chunk,
  messageId?: string | null,
): AcpTranscriptItem[] {
  const index = messageId
    ? transcript.findIndex(
        (item) => item.type === "message" && item.messageId === messageId,
      )
    : transcript.length - 1;
  const current = transcript[index];
  const merge = (item: Extract<AcpTranscriptItem, { type: "message" }>) => {
    if (chunk.type === "text") return { ...item, text: item.text + chunk.text };
    const ref = registerAttachment({
      name: chunk.uri ? chunk.uri.split(/[\\/]/).pop() ?? "image" : "image",
      mimeType: chunk.mimeType,
      data: chunk.data,
    });
    return { ...item, attachments: [...(item.attachments ?? []), ref] };
  };
  if (current?.type === "message" && current.role === role) {
    return transcript.map((item, itemIndex) =>
      itemIndex === index ? merge(current) : item,
    );
  }
  return [
    ...transcript,
    merge({
      id: messageId ?? newId(role),
      type: "message",
      role,
      text: "",
      ...(messageId ? { messageId } : {}),
    }),
  ];
}

export function applyAcpUpdate(
  transcript: AcpTranscriptItem[],
  update: SessionUpdate,
  options: { acceptUserMessageChunks?: boolean } = {},
): AcpTranscriptItem[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const chunk = toChunk(update.content);
      return chunk ? appendChunk(transcript, "assistant", chunk, update.messageId) : transcript;
    }
    case "agent_thought_chunk": {
      const chunk = toChunk(update.content);
      return chunk ? appendChunk(transcript, "thought", chunk, update.messageId) : transcript;
    }
    case "user_message_chunk": {
      // Powerhouse records submitted prompts immediately. Ignoring echoed user
      // chunks avoids duplicates. During session/load, the agent is the source
      // of truth and replays the complete transcript, including user messages.
      if (!options.acceptUserMessageChunks) return transcript;
      const chunk = toChunk(update.content);
      return chunk ? appendChunk(transcript, "user", chunk, update.messageId) : transcript;
    }
    case "tool_call":
      return [
        ...transcript,
        {
          id: `tool-${update.toolCallId}`,
          type: "tool",
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
          content: update.content,
          locations: update.locations,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
        },
      ];
    case "tool_call_update":
      return transcript.map((item) =>
        item.type === "tool" && item.toolCallId === update.toolCallId
          ? {
              ...item,
              ...(update.title != null ? { title: update.title } : {}),
              ...(update.kind != null ? { kind: update.kind } : {}),
              ...(update.status != null ? { status: update.status } : {}),
              ...(update.content != null ? { content: update.content } : {}),
              ...(update.locations != null ? { locations: update.locations } : {}),
              ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
              ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
            }
          : item,
      );
    case "plan": {
      const withoutPlan = transcript.filter((item) => item.type !== "plan");
      return [...withoutPlan, { id: "plan", type: "plan", entries: update.entries }];
    }
    default:
      return transcript;
  }
}
