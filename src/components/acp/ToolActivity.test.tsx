import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AcpTranscript } from "./AcpTranscript";
import { ToolActivity } from "./ToolActivity";

it("groups adjacent tool calls without crossing a message and keeps failures visible", () => {
  const html = renderToStaticMarkup(<AcpTranscript busy={false} agentName="Agent" branchName="main" commandCount={0} items={[
    { id: "t1", type: "tool", toolCallId: "1", title: "Read file", status: "completed" },
    { id: "t2", type: "tool", toolCallId: "2", title: "Run test", status: "failed" },
    { id: "m1", type: "message", role: "assistant", text: "Fixing the failure." },
    { id: "t3", type: "tool", toolCallId: "3", title: "Try again", status: "in_progress" },
  ]} />);
  expect(html).toContain("2 tool calls");
  expect(html).toContain("1 failed");
  expect(html.indexOf("Fixing the failure.")).toBeLessThan(html.indexOf("Try again"));
  expect(html).not.toContain("3 tool calls");
});

it("renders before and after edit content as escaped code", () => {
  const html = renderToStaticMarkup(<ToolActivity items={[{ id: "t", type: "tool", toolCallId: "t", title: "Edit", status: "completed", content: [{ type: "diff", path: "index.html", oldText: "old", newText: "<script>test()</script>" }] }]} />);
  expect(html).toContain("Before");
  expect(html).toContain("After");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});
