import { describe, expect, it } from "vitest";
import type {
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import {
  cycleMode,
  resolveModels,
  resolveModes,
  resolveReasoning,
  type AgentControlState,
} from "./agentControls";

const state = (partial: Partial<AgentControlState>): AgentControlState => ({
  modes: null,
  configOptions: [],
  commands: [],
  ...partial,
});

const modeState = (current: string): SessionModeState => ({
  currentModeId: current,
  availableModes: [
    { id: "normal", name: "Normal" },
    { id: "plan", name: "Plan" },
    { id: "accept", name: "Accept Edits" },
  ],
});

describe("agent controls", () => {
  it("resolves ACP modes and cycles to the next one", () => {
    const modes = resolveModes(state({ modes: modeState("normal") }));
    expect(modes.supported).toBe(true);
    if (!modes.supported) return;
    expect(modes.current?.label).toBe("Normal");
    expect(modes.options.map((o) => o.label)).toEqual([
      "Normal",
      "Plan",
      "Accept Edits",
    ]);

    const next = cycleMode(state({ modes: modeState("normal") }));
    expect(next).toEqual({
      supported: true,
      apply: { kind: "mode", modeId: "plan" },
      label: "Plan",
    });
  });

  it("wraps around when cycling from the last mode", () => {
    expect(cycleMode(state({ modes: modeState("accept") }))).toEqual({
      supported: true,
      apply: { kind: "mode", modeId: "normal" },
      label: "Normal",
    });
  });

  it("falls back to a config-based `mode` option when ACP modes are absent", () => {
    const configOptions: SessionConfigOption[] = [
      {
        id: "approval",
        name: "Approval",
        category: "mode",
        type: "select",
        currentValue: "suggest",
        options: [
          { value: "suggest", name: "Suggest" },
          { value: "auto", name: "Auto" },
        ],
      },
    ];
    const next = cycleMode(state({ configOptions }));
    expect(next).toEqual({
      supported: true,
      apply: { kind: "config", configId: "approval", value: "auto" },
      label: "Auto",
    });
  });

  it("reports unsupported when the agent advertises no modes", () => {
    const result = cycleMode(state({}));
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toMatch(/no mode/i);
  });

  it("reports unsupported when only one mode exists", () => {
    const single: SessionModeState = {
      currentModeId: "only",
      availableModes: [{ id: "only", name: "Only" }],
    };
    const result = cycleMode(state({ modes: single }));
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toMatch(/one mode/i);
  });

  it("resolves grouped model options and marks the active one", () => {
    const configOptions: SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "sonnet",
        options: [
          {
            group: "anthropic",
            name: "Anthropic",
            options: [
              { value: "opus", name: "Opus" },
              { value: "sonnet", name: "Sonnet" },
            ],
          },
        ],
      },
    ];
    const models = resolveModels(state({ configOptions }));
    expect(models.supported).toBe(true);
    if (!models.supported) return;
    expect(models.current?.label).toBe("Sonnet");
    expect(models.options.map((o) => o.label)).toEqual(["Opus", "Sonnet"]);
    expect(models.options[0].apply).toEqual({
      kind: "config",
      configId: "model",
      value: "opus",
    });
  });

  it("lists a pinned model outside the picker as the active option", () => {
    const configOptions: SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "claude-opus-4-8",
        options: [
          { value: "default", name: "Default" },
          { value: "claude-fable-5-1[1m]", name: "Fable 5.1" },
        ],
      },
    ];
    const models = resolveModels(state({ configOptions }));
    if (!models.supported) throw new Error("expected models");
    expect(models.current?.label).toBe("claude-opus-4-8");
    expect(models.options.map((o) => o.label)).toEqual([
      "claude-opus-4-8",
      "Default",
      "Fable 5.1",
    ]);
  });

  it("reports unsupported reasoning for agents without a thought level", () => {
    const result = resolveReasoning(state({}));
    expect(result.supported).toBe(false);
  });
});
