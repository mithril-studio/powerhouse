import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AcpComposer } from "./AcpComposer";

const props = { attachments: [], supportsImages: true, dragging: false, onPasteFiles: () => {}, onPickFiles: () => {}, onRemoveAttachment: () => {}, active: true, agentName: "Claude", draft: "Next thought", onDraftChange: () => {}, onSubmit: () => {}, onOpenCommands: () => {}, onCancel: () => {} };
it("lets users draft while working and offers an explicit Stop control", () => {
  const html = renderToStaticMarkup(<AcpComposer {...props} busy />);
  expect(html).toContain("Stop agent");
  expect(html).not.toMatch(/<textarea[^>]*disabled/);
  expect(html).toContain("Next thought");
});
it("offers visible Send and Commands controls when ready", () => {
  const html = renderToStaticMarkup(<AcpComposer {...props} busy={false} />);
  expect(html).toContain('type="submit"');
  expect(html).toContain("Send message");
  expect(html).toContain("Agent commands");
  expect(html).not.toContain("@file");
});
