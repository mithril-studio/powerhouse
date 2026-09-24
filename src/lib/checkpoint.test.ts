import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { AcpTranscriptItem } from "./acpTranscript";
import { distillCheckpoint, type CheckpointInput } from "./checkpoint";

const at = new Date("2026-09-24T10:30:00.000Z");

const input = (transcript: AcpTranscriptItem[]): CheckpointInput => ({
  transcript,
  key: "chat1234",
  branch: "feature/x",
  agent: "Claude Code",
  at,
});

const userMsg = (text: string): AcpTranscriptItem => ({ id: "u", type: "message", role: "user", text });
const asstMsg = (text: string): AcpTranscriptItem => ({ id: "a", type: "message", role: "assistant", text });
const tool = (partial: Partial<Extract<AcpTranscriptItem, { type: "tool" }>>): AcpTranscriptItem => ({
  id: "t",
  type: "tool",
  toolCallId: "tc",
  title: "tool",
  ...partial,
});

describe("distillCheckpoint", () => {
  it("skips a run with no tool activity", () => {
    expect(distillCheckpoint(input([userMsg("what is 2+2?"), asstMsg("4")]))).toBeNull();
  });

  it("summarises task, files, commands and outcome", () => {
    const cp = distillCheckpoint(
      input([
        userMsg("fix the drain bug"),
        tool({ kind: "edit", locations: [{ path: "src/a.rs" }, { path: "src/b.rs" }] }),
        tool({ kind: "execute", title: "cargo test", rawInput: { command: "cargo test -p powerhouse" } }),
        asstMsg("Done — tests pass."),
      ]),
    );
    expect(cp).not.toBeNull();
    expect(cp!.body).toContain("- [task] fix the drain bug");
    expect(cp!.body).toContain("- [files] src/a.rs, src/b.rs");
    expect(cp!.body).toContain("- [commands] cargo test -p powerhouse");
    expect(cp!.body).toContain("- [outcome] Done — tests pass.");
    expect(cp!.body).toContain("2 tool calls");
  });

  it("keys the title per session so it overwrites itself", () => {
    const cp = distillCheckpoint(input([userMsg("do a thing"), tool({ kind: "edit", locations: [{ path: "x" }] })]));
    expect(cp!.title).toContain("[chat1234]");
    expect(cp!.title).toContain("2026-09-24 10:30");
  });

  it("de-duplicates files and caps the list", () => {
    const locations = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.ts` }));
    const cp = distillCheckpoint(
      input([userMsg("touch many"), tool({ kind: "edit", locations }), tool({ kind: "edit", locations: [{ path: "f0.ts" }] })]),
    );
    expect(cp!.body).toContain("(+5 more)");
    expect(cp!.body.match(/f0\.ts/g)?.length).toBe(1);
  });

  it("falls back to a file subject when there is no task text", () => {
    const cp = distillCheckpoint(input([tool({ kind: "edit", locations: [{ path: "only.ts" }] })]));
    expect(cp!.title).toContain("only.ts");
  });
});
