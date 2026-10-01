import { describe, expect, it } from "vitest";
import { applyAcpUpdate, type AcpTranscriptItem } from "./acpTranscript";
import { handoffText, streamLineUpdates } from "./cloudStream";

const apply = (items: AcpTranscriptItem[], lines: string[]) =>
  lines.reduce(
    (acc, line, i) => streamLineUpdates(line, `k${i}`).reduce((inner, u) => applyAcpUpdate(inner, u), acc),
    items,
  );

describe("streamLineUpdates", () => {
  it("renders a cloud turn like a local one: text, tool call, tool result", () => {
    const items = apply([], [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", uuid: "u1", message: { id: "m1", content: [{ type: "text", text: "Looking." }] } }),
      JSON.stringify({
        type: "assistant",
        uuid: "u2",
        message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] },
      }),
      JSON.stringify({ type: "assistant", uuid: "u3", message: { id: "m1", content: [{ type: "text", text: "Done." }] } }),
      JSON.stringify({ type: "result", result: "Done.", is_error: false }),
      "not json",
    ]);
    expect(items.map((i) => (i.type === "message" ? `${i.role}:${i.text}` : i.type))).toEqual([
      "assistant:Looking.",
      "tool",
      "assistant:Done.",
    ]);
    const tool = items[1];
    expect(tool).toMatchObject({ type: "tool", toolCallId: "t1", kind: "execute", status: "completed", title: "Bash pnpm test" });
    expect(tool.type === "tool" && tool.content).toEqual([{ type: "content", content: { type: "text", text: "ok" } }]);
  });

  it("marks failed tool results and points edits at their file", () => {
    const items = apply([], [
      JSON.stringify({
        type: "assistant",
        uuid: "u1",
        message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/home/boxd/repo/a.ts" } }] },
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] } }),
    ]);
    expect(items[0]).toMatchObject({ kind: "edit", status: "failed", locations: [{ path: "/home/boxd/repo/a.ts" }] });
  });
});

describe("handoffText", () => {
  it("carries the conversation, newest last, without tools or system notes", () => {
    const items: AcpTranscriptItem[] = [
      { id: "1", type: "message", role: "user", text: "Fix the login bug" },
      { id: "2", type: "tool", toolCallId: "t", title: "Read a.ts" },
      { id: "3", type: "message", role: "system", text: "memory: briefed" },
      { id: "4", type: "message", role: "assistant", text: "Found it in auth.ts" },
    ];
    const text = handoffText(items);
    expect(text).toContain("## User\nFix the login bug\n\n## Assistant\nFound it in auth.ts");
    expect(text).not.toContain("Read a.ts");
    expect(text).not.toContain("memory");
  });

  it("is empty for an empty chat and trims from the front when long", () => {
    expect(handoffText([])).toBe("");
    const long: AcpTranscriptItem[] = [
      { id: "1", type: "message", role: "user", text: "OLD ".repeat(100) },
      { id: "2", type: "message", role: "user", text: "NEWEST" },
    ];
    const text = handoffText(long, 50);
    expect(text).toContain("[earlier conversation trimmed]");
    expect(text).toContain("NEWEST");
  });
});
