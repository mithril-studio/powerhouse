import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { appendCloudResult, appendUserMessage, applyAcpUpdate, latestUsage, type AcpTranscriptItem } from "./acpTranscript";

describe("appendCloudResult", () => {
  it("posts a run's card once and never again (restart-safe by run id)", () => {
    const once = appendCloudResult([], "run-1", true);
    expect(once).toEqual([{ id: "cloud-result-run-1", type: "cloud-result", runId: "run-1", late: true }]);
    // A replayed record update or a restart must not add a second card.
    const twice = appendCloudResult(once, "run-1", false);
    expect(twice).toBe(once);
    // A different run gets its own card.
    const other = appendCloudResult(once, "run-2", false);
    expect(other).toHaveLength(2);
  });
});

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

describe("image content", () => {
  it("records a submitted prompt's attachments on the user message", () => {
    const ref = { id: "att-1", name: "shot.png", mimeType: "image/png", bytes: 2 };
    const [item] = appendUserMessage([], "what is this?", [ref]);
    expect(item).toEqual(
      expect.objectContaining({ role: "user", text: "what is this?", attachments: [ref] }),
    );
    expect(appendUserMessage([], "plain")[0]).not.toHaveProperty("attachments");
  });

  it("attaches replayed user image chunks to the same message as their text", () => {
    const text: SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "see attached" },
    };
    const image: SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "image", mimeType: "image/png", data: "aGk=", uri: "file:///x/shot.png" },
    };
    const options = { acceptUserMessageChunks: true };
    const transcript = applyAcpUpdate(applyAcpUpdate([], text, options), image, options);

    expect(transcript).toHaveLength(1);
    const [item] = transcript;
    expect(item).toMatchObject({ role: "user", text: "see attached" });
    expect(item.type === "message" && item.attachments).toEqual([
      expect.objectContaining({ name: "shot.png", mimeType: "image/png", bytes: 2 }),
    ]);
  });

  it("renders images the agent returns inside its message", () => {
    const image: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "image", mimeType: "image/jpeg", data: "aGk=" },
    };
    const [item] = applyAcpUpdate([], image);
    expect(item).toMatchObject({ role: "assistant", text: "", messageId: "m1" });
    expect(item.type === "message" && item.attachments?.[0]?.mimeType).toBe("image/jpeg");
  });
});

describe("usage_update", () => {
  const usage = (used: number, size = 200_000): SessionUpdate => ({
    sessionUpdate: "usage_update",
    used,
    size,
  });
  const user = (text: string): AcpTranscriptItem => ({
    id: `user-${text}`,
    type: "message",
    role: "user",
    text,
  });
  const assistant = (text: string): AcpTranscriptItem => ({
    id: `assistant-${text}`,
    type: "message",
    role: "assistant",
    text,
  });

  it("appends a usage marker at the end of the current turn", () => {
    const transcript = applyAcpUpdate([user("hi"), assistant("hello")], usage(12_000));
    expect(transcript.map((item) => item.type)).toEqual(["message", "message", "usage"]);
    expect(transcript[2]).toMatchObject({ type: "usage", used: 12_000, size: 200_000 });
  });

  it("keeps only the newest reading within one turn", () => {
    let transcript = applyAcpUpdate([user("hi")], usage(10_000));
    transcript = applyAcpUpdate(transcript, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read",
      status: "completed",
    });
    transcript = applyAcpUpdate(transcript, usage(15_000));
    const readings = transcript.filter((item) => item.type === "usage");
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ used: 15_000 });
    expect(transcript[transcript.length - 1]?.type).toBe("usage");
  });

  it("preserves earlier turns' readings so usage is visible at each point", () => {
    let transcript = applyAcpUpdate([user("one"), assistant("a")], usage(10_000));
    transcript = [...transcript, user("two"), assistant("b")];
    transcript = applyAcpUpdate(transcript, usage(25_000));
    const readings = transcript
      .filter((item) => item.type === "usage")
      .map((item) => (item.type === "usage" ? item.used : null));
    expect(readings).toEqual([10_000, 25_000]);
  });

  it("carries cost through when the agent reports it", () => {
    const transcript = applyAcpUpdate([], {
      sessionUpdate: "usage_update",
      used: 5_000,
      size: 200_000,
      cost: { amount: 0.42, currency: "USD" },
    });
    expect(transcript[0]).toMatchObject({ cost: { amount: 0.42, currency: "USD" } });
  });
});

describe("latestUsage", () => {
  it("returns the most recent reading or null", () => {
    expect(latestUsage([])).toBeNull();
    const transcript = applyAcpUpdate(
      applyAcpUpdate([], { sessionUpdate: "usage_update", used: 1, size: 10 }),
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "x" } },
    );
    const withSecond = applyAcpUpdate(
      [...transcript, { id: "u", type: "message", role: "user", text: "next" }],
      { sessionUpdate: "usage_update", used: 7, size: 10 },
    );
    expect(latestUsage(withSecond)).toMatchObject({ used: 7 });
  });
});
