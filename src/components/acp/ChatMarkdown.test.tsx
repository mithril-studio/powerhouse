import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./ChatMarkdown";
import { AcpTranscript } from "./AcpTranscript";

it("renders readable headings, lists, tables and copyable code", () => {
  const html = renderToStaticMarkup(<ChatMarkdown text={'## Results\n\n**Passed**\n\n- One\n- Two\n\n```ts\nconst ok = true;\n```\n\n| Test | Result |\n| --- | --- |\n| Unit | Pass |'} />);
  expect(html).toContain("<h2>Results</h2>");
  expect(html).toContain("<strong>Passed</strong>");
  expect(html).toContain("<li>One</li>");
  expect(html).toContain("<table>");
  expect(html).toContain("Copy code");
  expect(html).toContain("const ok = true;");
});

it("does not execute HTML, unsafe links or load remote images", () => {
  const html = renderToStaticMarkup(<ChatMarkdown text={'<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![Tracking](https://evil.example/pixel.png)\n\n[Local](file:///etc/passwd)'} />);
  expect(html).not.toContain("<script");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('href="file:');
  expect(html).not.toContain("<img");
  expect(html).toContain("Tracking");
});

it("renders agent images and tool result images without opening tool details", () => {
  const html = renderToStaticMarkup(<AcpTranscript busy={false} agentName="Claude" branchName="test" commandCount={0} items={[
    { id: "image", type: "image", role: "assistant", mimeType: "image/png", data: "aGVsbG8=" },
    { id: "tool", type: "tool", toolCallId: "t1", title: "Screenshot", status: "completed", content: [{ type: "content", content: { type: "image", mimeType: "image/png", data: "aGVsbG8=" } }] },
  ]} />);
  expect(html.match(/aria-label="Enlarge agent image"/g)).toHaveLength(2);
  // Both previews are visible outside the collapsed tool disclosure.
  expect(html.replace(/<details[\s\S]*?<\/details>/g, "").match(/aria-label="Enlarge agent image"/g)).toHaveLength(2);
});
