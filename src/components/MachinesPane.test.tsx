import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { MachineRow } from "../lib/machines";
import { MachineItem } from "./MachinesPane";

const render = (m: MachineRow) =>
  renderToStaticMarkup(<MachineItem machine={m} current={false} busy={undefined} run={() => {}} />);

it("offers Delete only on Powerhouse-owned machines", () => {
  const owned = render({ name: "ph-a", status: "running", url: null, size: "2x8G", owned: true });
  const theirs = render({ name: "legal-ai-app", status: "running", url: null, size: null, owned: false });
  expect(owned).toContain("Delete");
  expect(theirs).not.toContain("Delete");
  expect(theirs).toContain("Connect");
  expect(theirs).toContain("Stop");
});

it("offers Start for a hibernated machine and disables the editor until it runs", () => {
  const html = render({ name: "e-learning", status: "hibernated", url: null, size: null, owned: false });
  expect(html).toContain(">Start<");
  expect(html).not.toContain(">Stop<");
  expect(html).toMatch(/disabled="" title="Start the machine first"/);
});

