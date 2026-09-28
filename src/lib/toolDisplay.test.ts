import { describe, expect, it } from "vitest";
import type { AcpTranscriptItem } from "./acpTranscript";
import { compactCommand, groupTools, summarizeTools, toolLabel, type ToolTranscriptItem } from "./toolDisplay";

const tool = (id: string, extra: Partial<ToolTranscriptItem> = {}): ToolTranscriptItem => ({
  id,
  type: "tool",
  toolCallId: id,
  title: id,
  kind: "execute",
  status: "completed",
  ...extra,
});
const msg = (id: string): AcpTranscriptItem => ({ id, type: "message", role: "assistant", text: id });

describe("groupTools", () => {
  it("folds consecutive tool calls and leaves singles alone", () => {
    const entries = groupTools([tool("a"), tool("b"), msg("m"), tool("c"), msg("n")]);
    expect(entries.map((e) => e.type)).toEqual(["tool-group", "message", "tool", "message"]);
    expect(entries[0].type === "tool-group" && entries[0].tools.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("compactCommand", () => {
  it("drops cd prefixes, env assignments and heredoc bodies", () => {
    expect(compactCommand("cd /Users/joost/x && npx vitest run")).toBe("npx vitest run");
    expect(compactCommand('PW=/tmp/a CHROME="/Applications/Google Chrome" node t.mjs')).toBe("node t.mjs");
    expect(compactCommand("python3 - <<'EOF'\np='x'\nEOF")).toBe("python3 - <<'EOF'");
  });

  it("shortens worktree and home paths", () => {
    expect(compactCommand("cat /Users/joost/.powerhouse/worktrees/wf/branch/web/a.js")).toBe("cat web/a.js");
    expect(compactCommand("ls /Users/joost/code")).toBe("ls ~/code");
  });
});

describe("toolLabel", () => {
  it("prefers the structured command and drops a verb the column already shows", () => {
    expect(toolLabel(tool("t", { title: "long", rawInput: { command: "cd /x && pnpm test" } }))).toBe("pnpm test");
    expect(toolLabel(tool("t", { kind: "read", title: "Read /tmp/a.png" }))).toBe("/tmp/a.png");
  });
});

describe("summarizeTools", () => {
  it("counts by verb, most frequent first", () => {
    expect(summarizeTools([tool("a", { kind: "read" }), tool("b"), tool("c")])).toBe("2 run · 1 read");
  });
});
