import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { AcpMarkdown } = await import("./AcpMarkdown");

const render = (text: string) => renderToStaticMarkup(createElement(AcpMarkdown, { text }));

describe("AcpMarkdown", () => {
  it("renders GFM tables as real tables", () => {
    const html = render("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("renders lists, emphasis, and fenced code", () => {
    const html = render("- **bold** item\n- second\n\n```ts\nconst x = 1;\n```");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<code class="language-ts">const x = 1;\n</code>');
  });

  it("does not render raw HTML from the agent", () => {
    expect(render("<script>alert(1)</script> hi")).not.toContain("<script>");
  });
});
