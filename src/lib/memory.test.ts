import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  briefQuery,
  composeBriefedPrompt,
  DEFAULT_MEMORY_SETTINGS,
  formatBrief,
  MAX_BRIEF_CHARS,
  MEMORY_SERVER_NAME,
  memoryMcpServers,
  memoryProjectSlug,
  memorySessionMeta,
  parseRecent,
  parseSearchResults,
  rankNotes,
  stripFrontmatter,
  type BriefNote,
} from "./memory";

const note = (partial: Partial<BriefNote>): BriefNote => ({
  title: "t",
  permalink: "powerhouse/gotcha/t",
  project: "powerhouse",
  type: "gotcha",
  snippet: "- [cause] x\n- [fix] y",
  updatedAt: "2026-09-01T00:00:00Z",
  score: 0,
  ...partial,
});

describe("memoryProjectSlug", () => {
  it("lowercases and slugs repo names", () => {
    expect(memoryProjectSlug("Specter AI")).toBe("specter-ai");
    expect(memoryProjectSlug("powerhouse")).toBe("powerhouse");
    expect(memoryProjectSlug("  ")).toBe("project");
  });
});

describe("memoryMcpServers", () => {
  it("emits one http server with the fixed name", () => {
    const servers = memoryMcpServers(DEFAULT_MEMORY_SETTINGS);
    expect(servers).toEqual([
      { type: "http", name: MEMORY_SERVER_NAME, url: "http://127.0.0.1:8765/mcp", headers: [] },
    ]);
  });

  it("adds a bearer header for a remote host", () => {
    const servers = memoryMcpServers({ enabled: true, url: "https://m.example/mcp ", token: "abc" });
    expect(servers[0]).toMatchObject({
      url: "https://m.example/mcp",
      headers: [{ name: "Authorization", value: "Bearer abc" }],
    });
  });

  it("is empty when memory is off or unconfigured", () => {
    expect(memoryMcpServers({ ...DEFAULT_MEMORY_SETTINGS, enabled: false })).toEqual([]);
    expect(memoryMcpServers({ ...DEFAULT_MEMORY_SETTINGS, url: " " })).toEqual([]);
  });
});

describe("memorySessionMeta", () => {
  it("switches off Claude auto-memory only when memory is on", () => {
    expect(memorySessionMeta(DEFAULT_MEMORY_SETTINGS)).toEqual({
      claudeCode: { options: { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } } },
    });
    expect(memorySessionMeta({ ...DEFAULT_MEMORY_SETTINGS, enabled: false })).toBeUndefined();
  });
});

describe("briefQuery", () => {
  it("keeps distinctive words, drops stop words and punctuation, bounded", () => {
    const q = briefQuery("Please add the telemetry writer test for src/lib/acpRegistry.ts, and fix the flaky vitest run!");
    expect(q).toBe("telemetry writer test src/lib/acpregistry.ts fix flaky vitest run");
    expect(briefQuery("the and for").length).toBe(0);
    expect(briefQuery(Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")).split(" ")).toHaveLength(12);
  });
});

describe("parsers", () => {
  it("reads search_notes json output", () => {
    const raw = {
      results: [
        {
          title: "Drain readers",
          type: "entity",
          score: 1.2,
          permalink: "powerhouse/gotcha/drain-readers",
          content: "- [cause] a\n- [fix] b",
          matched_chunk: "- [fix] b",
          updated_at: "2026-09-22T00:00:00Z",
          metadata: { note_type: "gotcha" },
        },
        { title: "obs only", type: "observation", permalink: "x" },
      ],
    };
    expect(parseSearchResults(raw, "powerhouse")).toEqual([
      {
        title: "Drain readers",
        permalink: "powerhouse/gotcha/drain-readers",
        project: "powerhouse",
        type: "gotcha",
        snippet: "- [fix] b",
        updatedAt: "2026-09-22T00:00:00Z",
        score: 1.2,
      },
    ]);
    expect(parseSearchResults(null, "p")).toEqual([]);
  });

  it("reads recent_activity json output", () => {
    const raw = [
      { type: "entity", title: "A", permalink: "global/decision/a", created_at: "2026-09-20T00:00:00Z" },
      { type: "relation", title: "ignored", permalink: "x" },
    ];
    expect(parseRecent(raw, "global")).toEqual([
      { title: "A", permalink: "global/decision/a", project: "global", type: "", snippet: "", updatedAt: "2026-09-20T00:00:00Z", score: 0 },
    ]);
  });

  it("strips frontmatter", () => {
    expect(stripFrontmatter("---\ntitle: x\n---\n\n- [a] b")).toBe("- [a] b");
    expect(stripFrontmatter("- [a] b")).toBe("- [a] b");
  });
});

describe("rankNotes", () => {
  it("dedupes by permalink keeping the best of both records", () => {
    const ranked = rankNotes([
      note({ score: 0, snippet: "", type: "" }),
      note({ score: 0.9, snippet: "- [fix] y", type: "gotcha" }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ score: 0.9, snippet: "- [fix] y", type: "gotcha" });
  });

  it("orders search hits first, then type priority, then recency", () => {
    const ranked = rankNotes([
      note({ permalink: "p/pointer", type: "pointer", updatedAt: "2026-09-23" }),
      note({ permalink: "p/hit", type: "pointer", score: 0.5 }),
      note({ permalink: "p/correction", type: "correction", updatedAt: "2026-01-01" }),
      note({ permalink: "p/gotcha-new", type: "gotcha", updatedAt: "2026-09-10" }),
      note({ permalink: "p/gotcha-old", type: "gotcha", updatedAt: "2026-08-10" }),
    ]);
    expect(ranked.map((n) => n.permalink)).toEqual([
      "p/hit",
      "p/correction",
      "p/gotcha-new",
      "p/gotcha-old",
      "p/pointer",
    ]);
  });

  it("is bounded", () => {
    const many = Array.from({ length: 30 }, (_, i) => note({ permalink: `p/${i}` }));
    expect(rankNotes(many, 5)).toHaveLength(5);
  });
});

describe("formatBrief", () => {
  it("is empty with no notes", () => {
    expect(formatBrief([], "powerhouse")).toBe("");
  });

  it("renders a bounded, labelled brief with the write instruction", () => {
    const brief = formatBrief(
      [note({ snippet: "- [cause] a\n- [fix] b\n- [c] c\n- [d] d\n- [e] dropped" })],
      "powerhouse",
    );
    expect(brief.startsWith("<memory-brief>")).toBe(true);
    expect(brief).toContain("Scopes: global, powerhouse");
    expect(brief).toContain("## gotcha · t  (powerhouse/gotcha/t)");
    expect(brief).toContain("- [d] d");
    expect(brief).not.toContain("dropped");
    expect(brief).toContain("write_note in project `powerhouse`");
    expect(brief.endsWith("</memory-brief>")).toBe(true);
  });

  it("truncates oversized briefs but keeps the closing tag", () => {
    const huge = Array.from({ length: 12 }, (_, i) =>
      note({ permalink: `p/${i}`, snippet: "x".repeat(900) }),
    );
    const brief = formatBrief(huge, "p");
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(brief.endsWith("</memory-brief>")).toBe(true);
  });
});

describe("composeBriefedPrompt", () => {
  it("prepends the brief and leaves the prompt untouched", () => {
    expect(composeBriefedPrompt("<memory-brief>\nb\n</memory-brief>", "do it")).toBe(
      "<memory-brief>\nb\n</memory-brief>\n\ndo it",
    );
    expect(composeBriefedPrompt("", "do it")).toBe("do it");
  });
});
