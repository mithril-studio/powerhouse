import type {
  Cost,
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
    }
  | AcpUsageItem;

/** Context-window snapshot reported by the agent after a model call. */
export interface AcpUsageItem {
  id: string;
  type: "usage";
  /** Tokens currently in the model's context. */
  used: number;
  /** Total context window size in tokens. */
  size: number;
  /** Cumulative session cost when the agent reports it. */
  cost?: Cost | null;
}

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
  const index = messageId
    ? transcript.findIndex(
        (item) => item.type === "message" && item.messageId === messageId,
      )
    : transcript.length - 1;
  const current = transcript[index];
  if (current?.type === "message" && current.role === role) {
    return transcript.map((item, itemIndex) =>
      itemIndex === index ? { ...current, text: current.text + text } : item,
    );
  }
  return [
    ...transcript,
    {
      id: messageId ?? newId(role),
      type: "message",
      role,
      text,
      ...(messageId ? { messageId } : {}),
    },
  ];
}

/**
 * Records the agent's latest context-window reading at the end of the
 * current turn. Agents emit usage after every model call, so a single turn
 * can produce many readings; only the newest one per turn is kept and it is
 * always the last item of that turn.
 */
function recordUsage(
  transcript: AcpTranscriptItem[],
  usage: { used: number; size: number; cost?: Cost | null },
): AcpTranscriptItem[] {
  let turnStart = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item.type === "message" && item.role === "user") {
      turnStart = index;
      break;
    }
  }
  const kept = transcript.filter(
    (item, index) => !(item.type === "usage" && index > turnStart),
  );
  return [
    ...kept,
    {
      id: newId("usage"),
      type: "usage",
      used: usage.used,
      size: usage.size,
      ...(usage.cost != null ? { cost: usage.cost } : {}),
    },
  ];
}

/** The most recent context-window reading in the transcript, if any. */
export function latestUsage(transcript: AcpTranscriptItem[]): AcpUsageItem | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item.type === "usage") return item;
  }
  return null;
}

export function applyAcpUpdate(
  transcript: AcpTranscriptItem[],
  update: SessionUpdate,
  options: { acceptUserMessageChunks?: boolean } = {},
): AcpTranscriptItem[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text"
        ? appendTextChunk(transcript, "assistant", update.content.text, update.messageId)
        : transcript;
    case "agent_thought_chunk":
      return update.content.type === "text"
        ? appendTextChunk(transcript, "thought", update.content.text, update.messageId)
        : transcript;
    case "user_message_chunk":
      // Powerhouse records submitted prompts immediately. Ignoring echoed user
      // chunks avoids duplicates. During session/load, the agent is the source
      // of truth and replays the complete transcript, including user messages.
      return options.acceptUserMessageChunks && update.content.type === "text"
        ? appendTextChunk(transcript, "user", update.content.text, update.messageId)
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
    case "usage_update":
      return recordUsage(transcript, update);
    default:
      return transcript;
  }
}
