import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { applyAcpUpdate, type AcpTranscriptItem } from "./acpTranscript";

describe("applyAcpUpdate", () => {
  it("combines streamed assistant chunks into one message", () => {
    const first: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-1",
      content: { type: "text", text: "Hello" },
    };
    const second: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-1",
      content: { type: "text", text: " world" },
    };

    const transcript = applyAcpUpdate(applyAcpUpdate([], first), second);

    expect(transcript).toEqual([
      expect.objectContaining({ type: "message", role: "assistant", text: "Hello world" }),
    ]);
  });

  it("updates a tool call in place", () => {
    const created: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read package.json",
      kind: "read",
      status: "in_progress",
    };
    const completed: SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: "done",
    };

    const transcript = applyAcpUpdate(applyAcpUpdate([], created), completed);

    expect(transcript).toEqual([
      expect.objectContaining({
        type: "tool",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: "done",
      }),
    ]);
  });

  it("replaces the current plan instead of appending duplicates", () => {
    const original: AcpTranscriptItem[] = [
      { id: "plan", type: "plan", entries: [] },
    ];
    const update: SessionUpdate = {
      sessionUpdate: "plan",
      entries: [{ content: "Build UI", priority: "high", status: "in_progress" }],
    };

    const transcript = applyAcpUpdate(original, update);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toEqual(expect.objectContaining({ type: "plan", entries: update.entries }));
  });

  it("ignores echoed user chunks because prompts are recorded locally", () => {
    const update: SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Do the work" },
    };

    expect(applyAcpUpdate([], update)).toEqual([]);
  });

  it("accepts user chunks while an agent replays a loaded session", () => {
    const update: SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      messageId: "user-message-1",
      content: { type: "text", text: "Restore this prompt" },
    };

    expect(applyAcpUpdate([], update, { acceptUserMessageChunks: true })).toEqual([
      expect.objectContaining({ role: "user", text: "Restore this prompt" }),
    ]);
  });
});
