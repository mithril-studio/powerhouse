import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionControls } from "./SessionControls";

it("shows only advertised controls and disables changes during a turn", () => {
  const state = { modes: { currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan" }, { id: "build", name: "Build" }] }, configOptions: [], commands: [] };
  const html = renderToStaticMarkup(<SessionControls state={state} disabled onApply={() => {}} />);
  expect(html).toContain('aria-label="Mode"');
  expect(html).toContain('disabled=""');
  expect(html).toContain('value="mode:plan" selected=""');
  expect(html).not.toContain('aria-label="Model"');
  expect(html).not.toContain('aria-label="Reasoning"');
});
