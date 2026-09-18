import { describe, expect, it } from "vitest";
import type {
  AvailableCommand,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import type { AgentControlState } from "./agentControls";
import {
  buildPalette,
  filterPalette,
  flattenView,
  type PaletteItem,
  type PaletteView,
} from "./acpCommandPalette";

const state = (partial: Partial<AgentControlState>): AgentControlState => ({
  modes: null,
  configOptions: [],
  commands: [],
  ...partial,
});

const find = (view: PaletteView, id: string): PaletteItem | undefined =>
  flattenView(view).find((item) => item.id === id);

describe("hierarchical command palette", () => {
  const commands: AvailableCommand[] = [
    { name: "skill:review", description: "Run the review skill", input: { hint: "focus" } },
  ];
  const modes: SessionModeState = {
    currentModeId: "code",
    availableModes: [
      { id: "code", name: "Code" },
      { id: "plan", name: "Plan" },
    ],
  };
  const configOptions: SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "codex",
      options: [
        { value: "codex", name: "Codex" },
        { value: "mini", name: "Codex Mini" },
      ],
    },
  ];

  it("builds grouped root entries with submenus for session controls", () => {
    const view = buildPalette(state({ commands, modes, configOptions }));
    expect(view.groups.map((group) => group.heading)).toEqual([
      "Session",
      "Agent commands",
      "Powerhouse",
    ]);

    const mode = find(view, "session:mode");
    expect(mode?.label).toBe("Switch mode…");
    expect(mode?.hint).toBe("Code");
    expect(mode?.action.type).toBe("submenu");

    const model = find(view, "session:model");
    expect(model?.hint).toBe("Codex");

    // Commands come straight from available_commands_update — no per-agent lists.
    const command = find(view, "command:skill:review");
    expect(command?.label).toBe("/skill:review");
    expect(command?.action).toEqual({
      type: "insert_prompt",
      prompt: "/skill:review ",
    });

    expect(find(view, "powerhouse:native-cli")?.action).toEqual({ type: "native_cli" });
    expect(find(view, "powerhouse:restart")?.action).toEqual({ type: "restart" });
  });

  it("drills into a focused submenu that marks the active value", () => {
    const view = buildPalette(state({ modes, configOptions }));
    const model = find(view, "session:model");
    expect(model?.action.type).toBe("submenu");
    if (model?.action.type !== "submenu") return;
    const submenu = model.action.view;
    expect(submenu.title).toBe("Model");
    const items = flattenView(submenu);
    expect(items.map((item) => item.label)).toEqual(["Codex", "Codex Mini"]);
    expect(items[0].selected).toBe(true);
    expect(items[1].action).toEqual({
      type: "apply",
      op: { kind: "config", configId: "model", value: "mini" },
    });
  });

  it("omits session and command groups the agent does not advertise", () => {
    const view = buildPalette(state({}));
    expect(view.groups.map((group) => group.heading)).toEqual(["Powerhouse"]);
  });

  it("filters items across labels, descriptions, hints, and groups", () => {
    const view = buildPalette(state({ commands, modes, configOptions }));
    expect(
      flattenView(filterPalette(view, "review")).map((item) => item.id),
    ).toEqual(["command:skill:review"]);
    expect(
      flattenView(filterPalette(view, "powerhouse")).map((item) => item.id),
    ).toEqual(["powerhouse:native-cli", "powerhouse:restart"]);
  });
});
