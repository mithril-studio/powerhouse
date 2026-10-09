import { chatImageSource } from "./chatImage";
import type {
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

export type AcpMessageRole = "user" | "assistant" | "thought" | "system";

export type AcpTranscriptItem =
  | {
      id: string;
      type: "image";
      role: "user" | "assistant" | "thought";
      mimeType: string;
      data: string;
    }
  | {
      id: string;
      type: "message";
      role: AcpMessageRole;
      text: string;
      messageId?: string;
      tone?: "normal" | "error";
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
    };

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export function appendUserMessage(
  transcript: AcpTranscriptItem[],
  text: string,
): AcpTranscriptItem[] {
  return [...transcript, { id: newId("user"), type: "message", role: "user", text }];
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

function appendTextChunk(
  transcript: AcpTranscriptItem[],
  role: "user" | "assistant" | "thought",
  text: string,
  messageId?: string | null,
): AcpTranscriptItem[] {
  if (!text) return transcript;
  // Only coalesce adjacent chunks: images and tool events retain their order.
  const index = transcript.length - 1;
  const current = transcript[index];
  if (current?.type === "message" && current.role === role && current.messageId === (messageId ?? undefined)) {
    return transcript.map((item, itemIndex) =>
      itemIndex === index ? { ...current, text: current.text + text } : item,
    );
  }
  return [
    ...transcript,
    {
      id: newId(role),
      type: "message",
      role,
      text,
      ...(messageId ? { messageId } : {}),
    },
  ];
}

function appendContent(
  transcript: AcpTranscriptItem[],
  role: "user" | "assistant" | "thought",
  content: ContentBlock,
  messageId?: string | null,
): AcpTranscriptItem[] {
  if (content.type === "text") return appendTextChunk(transcript, role, content.text, messageId);
  if (content.type !== "image") return transcript;
  if (!chatImageSource(content.mimeType, content.data)) {
    return appendSystemMessage(transcript, "Image unavailable: unsupported format, invalid data, or image exceeds 6 MiB.");
  }
  return [...transcript, { id: newId("image"), type: "image", role, mimeType: content.mimeType, data: content.data }];
}

export function applyAcpUpdate(
  transcript: AcpTranscriptItem[],
  update: SessionUpdate,
  options: { acceptUserMessageChunks?: boolean } = {},
): AcpTranscriptItem[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return appendContent(transcript, "assistant", update.content, update.messageId);
    case "agent_thought_chunk":
      return appendContent(transcript, "thought", update.content, update.messageId);
    case "user_message_chunk":
      // Powerhouse records submitted prompts immediately. Ignoring echoed user
      // chunks avoids duplicates. During session/load, the agent is the source
      // of truth and replays the complete transcript, including user messages.
      return options.acceptUserMessageChunks
        ? appendContent(transcript, "user", update.content, update.messageId)
        : transcript;
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
