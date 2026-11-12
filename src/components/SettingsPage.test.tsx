import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useAppStore } from "../store/appStore";
import { SettingsPage } from "./SettingsPage";

vi.mock("../store/appStore", async (original) => {
  const actual = await original<typeof import("../store/appStore")>();
  return { ...actual, useAppStore: Object.assign(
    (select: (s: ReturnType<typeof actual.useAppStore.getState>) => unknown) => select(actual.useAppStore.getState()),
    actual.useAppStore,
  ) };
});
vi.mock("../lib/terminalRegistry", () => ({ disposeTerminal: vi.fn(), fitTerminal: vi.fn(), spawnTerminal: vi.fn() }));

beforeEach(() => {
  useAppStore.getState().hydrate(null);
  useAppStore.getState().closeSettings();
});

it("places Memory and Telemetry inside Settings", () => {
  useAppStore.getState().openSettings("memory");
  const html = renderToStaticMarkup(<SettingsPage />);
  expect(html).toContain('aria-label="Settings sections"');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain("Project memory");
  expect(html).toContain("Telemetry</button>");
  expect(html).not.toContain("Rebuild projections");
});

it("embeds telemetry in a single settings dialog", () => {
  useAppStore.getState().openSettings("telemetry");
  const html = renderToStaticMarkup(<SettingsPage />);
  expect(html.match(/role="dialog"/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Telemetry"');
  expect(html).toContain("Rebuild projections");
  expect(html).toContain("Back to workspace");
  expect(html).not.toContain("Close telemetry");
  useAppStore.getState().closeSettings();
  expect(renderToStaticMarkup(<SettingsPage />)).toBe("");
});

it("opens general settings by default and keeps navigation out of saved preferences", () => {
  const settings = useAppStore.getState().settings;
  useAppStore.getState().openSettings("memory");
  useAppStore.getState().closeSettings();
  useAppStore.getState().openSettings();
  expect(useAppStore.getState().settingsSection).toBe("general");
  expect(useAppStore.getState().settings).toBe(settings);
  expect(renderToStaticMarkup(<SettingsPage />)).toContain("Powerhouse account");
});
