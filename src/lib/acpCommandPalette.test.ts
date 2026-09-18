import { describe, expect, it } from "vitest";
import type {
  AvailableCommand,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import { buildAcpPaletteItems, filterAcpPaletteItems } from "./acpCommandPalette";

describe("ACP command palette", () => {
  it("combines agent commands, modes, config values, and Powerhouse actions", () => {
    const commands: AvailableCommand[] = [
      {
        name: "skill:review",
        description: "Run the review skill",
        input: { hint: "optional focus" },
      },
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
        options: [{ value: "codex", name: "Codex" }],
      },
      {
        id: "verbose",
        name: "Verbose tools",
        type: "boolean",
        currentValue: false,
      },
    ];

    const items = buildAcpPaletteItems({ commands, modes, configOptions });

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "command:skill:review",
          group: "Agent commands",
          label: "/skill:review",
          action: { type: "insert_prompt", prompt: "/skill:review " },
        }),
        expect.objectContaining({
          id: "mode:plan",
          label: "Plan",
          selected: false,
          action: { type: "mode", modeId: "plan" },
        }),
        expect.objectContaining({
          id: "config:model:codex",
          label: "Model · Codex",
          selected: true,
        }),
        expect.objectContaining({
          id: "config:verbose",
          label: "Verbose tools · Off",
          action: {
            type: "config",
            configId: "verbose",
            value: true,
          },
        }),
        expect.objectContaining({ id: "powerhouse:terminal", label: "Open terminal" }),
      ]),
    );
  });

  it("filters by labels, descriptions, and groups", () => {
    const items = buildAcpPaletteItems({
      commands: [{ name: "skill:review", description: "Check code quality" }],
      modes: null,
      configOptions: [],
    });

    expect(filterAcpPaletteItems(items, "code quality").map((item) => item.id)).toEqual([
      "command:skill:review",
    ]);
    expect(filterAcpPaletteItems(items, "powerhouse").map((item) => item.id)).toEqual([
      "powerhouse:terminal",
    ]);
  });
});
