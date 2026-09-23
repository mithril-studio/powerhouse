// Semantic agent controls: a deep module between the UI and ACP.
//
// The UI speaks Powerhouse concepts ("cycle the mode", "change the model") and
// this module resolves them against whatever the connected agent actually
// advertises — ACP `modes`, config options categorized as `mode`/`model`/
// `thought_level`, or a clear "unsupported" result. No agent-specific branching
// (`if agent === "claude"`) ever leaks into the interface.
import type {
  AvailableCommand,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";

/** Everything the agent has told us about the live session. */
export interface AgentControlState {
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
  commands: AvailableCommand[];
}

/** A control the current agent cannot fulfil, with a user-facing reason. */
export interface Unsupported {
  supported: false;
  reason: string;
}

const unsupported = (reason: string): Unsupported => ({ supported: false, reason });

/** How a resolved choice is applied back through ACP. */
export type ApplyOp =
  | { kind: "mode"; modeId: string }
  | { kind: "config"; configId: string; value: string | boolean };

/** A single selectable value within a semantic control (mode, model, …). */
export interface ControlOption {
  id: string;
  label: string;
  description?: string;
  active: boolean;
  apply: ApplyOp;
}

/** A resolved multi-choice control (the set of modes, models, or levels). */
export interface Selector {
  supported: true;
  title: string;
  current?: ControlOption;
  options: ControlOption[];
}

/** The next mode to apply when cycling, plus its label for feedback. */
export interface ModeCycle {
  supported: true;
  apply: ApplyOp;
  label: string;
}

function isGroup(
  entry: SessionConfigSelectOption | SessionConfigSelectGroup,
): entry is SessionConfigSelectGroup {
  return "group" in entry;
}

function selectValues(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    isGroup(entry) ? entry.options : [entry],
  );
}

function selectorFromConfig(
  configOptions: SessionConfigOption[],
  category: string,
  title: string,
): Selector | Unsupported {
  const option = configOptions.find(
    (candidate) => candidate.category === category && candidate.type === "select",
  );
  if (!option) return unsupported(`No ${title.toLowerCase()} options are available`);
  const options: ControlOption[] = selectValues(option).map((value) => ({
    id: `${option.id}:${value.value}`,
    label: value.name,
    description: value.description ?? undefined,
    active: option.currentValue === value.value,
    apply: { kind: "config", configId: option.id, value: value.value },
  }));
  // A pinned model outside the picker (e.g. Opus 4.8) is still the live value.
  const current = option.currentValue;
  if (typeof current === "string" && current && !options.some((o) => o.active)) {
    options.unshift({
      id: `${option.id}:${current}`,
      label: current,
      active: true,
      apply: { kind: "config", configId: option.id, value: current },
    });
  }
  return { supported: true, title, current: options.find((o) => o.active), options };
}

/** The interaction modes, preferring ACP `modes`, else a `mode` config option. */
export function resolveModes(state: AgentControlState): Selector | Unsupported {
  const modes = state.modes;
  if (modes && modes.availableModes.length > 0) {
    const options: ControlOption[] = modes.availableModes.map((mode) => ({
      id: `mode:${mode.id}`,
      label: mode.name,
      description: mode.description ?? undefined,
      active: modes.currentModeId === mode.id,
      apply: { kind: "mode", modeId: mode.id },
    }));
    return {
      supported: true,
      title: "Mode",
      current: options.find((o) => o.active),
      options,
    };
  }
  return selectorFromConfig(state.configOptions, "mode", "Mode");
}

/** The selectable models, if the agent advertises a `model` config option. */
export function resolveModels(state: AgentControlState): Selector | Unsupported {
  return selectorFromConfig(state.configOptions, "model", "Model");
}

/** The reasoning/thinking levels, if advertised as a `thought_level` option. */
export function resolveReasoning(state: AgentControlState): Selector | Unsupported {
  return selectorFromConfig(state.configOptions, "thought_level", "Reasoning");
}

/** The next mode after the current one, wrapping around. */
export function cycleMode(state: AgentControlState): ModeCycle | Unsupported {
  const modes = resolveModes(state);
  if (!modes.supported) return modes;
  if (modes.options.length < 2) return unsupported("Only one mode is available");
  const index = modes.options.findIndex((option) => option.active);
  const next = modes.options[(index + 1) % modes.options.length];
  return { supported: true, apply: next.apply, label: next.label };
}

/** The active label of a resolved selector, for compact footer display. */
export function currentLabel(selector: Selector | Unsupported): string | undefined {
  return selector.supported ? selector.current?.label : undefined;
}
