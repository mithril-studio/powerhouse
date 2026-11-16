import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AcpComposer } from "./AcpComposer";
import type { Selector } from "../../lib/agentControls";

const props = { attachments: [], supportsImages: true, dragging: false, onPasteFiles: () => {}, onPickFiles: () => {}, onRemoveAttachment: () => {}, active: true, agentName: "Claude", draft: "Next thought", onDraftChange: () => {}, onSubmit: () => {}, onOpenCommands: () => {}, onCancel: () => {} };

const selector = (title: string, label: string): Selector => {
  const option = { id: label, label, active: true, apply: { kind: "config" as const, configId: title, value: label } };
  return { supported: true, title, current: option, options: [option] };
};

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

it("puts attach first and model, reasoning and Send last in one toolbar, with no hint text", () => {
  const html = renderToStaticMarkup(
    <AcpComposer {...props} busy={false} models={selector("Model", "Opus")} reasoning={selector("Reasoning", "High")} />,
  );
  const toolbar = html.slice(html.indexOf("composer-toolbar"));
  const order = ["Attach images", "Model: Opus", "Reasoning: High", "Send message"].map((label) => toolbar.indexOf(label));
  expect(order.every((index) => index > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).not.toContain("Enter to send");
});
