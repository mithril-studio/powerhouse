import type {
  AvailableCommand,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionModeState,
} from "@agentclientprotocol/sdk";

export type AcpPaletteAction =
  | { type: "insert_prompt"; prompt: string }
  | { type: "mode"; modeId: string }
  | { type: "config"; configId: string; value: string | boolean }
  | { type: "terminal" };

export interface AcpPaletteItem {
  id: string;
  group: "Agent commands" | "Modes" | "Configuration" | "Powerhouse";
  label: string;
  description?: string;
  selected?: boolean;
  action: AcpPaletteAction;
}

function commandPrompt(command: AvailableCommand): string {
  const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
  return command.input ? `${name} ` : name;
}

function isGroup(value: object): value is SessionConfigSelectGroup {
  return "group" in value;
}

function configItems(option: SessionConfigOption): AcpPaletteItem[] {
  if (option.type === "boolean") {
    return [
      {
        id: `config:${option.id}`,
        group: "Configuration",
        label: `${option.name} · ${option.currentValue ? "On" : "Off"}`,
        description: option.description ?? "Toggle this agent setting",
        action: {
          type: "config",
          configId: option.id,
          value: !option.currentValue,
        },
      },
    ];
  }

  return option.options.flatMap((entry) => {
    const values = isGroup(entry) ? entry.options : [entry];
    return values.map((value) => ({
      id: `config:${option.id}:${value.value}`,
      group: "Configuration" as const,
      label: `${option.name} · ${value.name}`,
      description: value.description ?? option.description ?? undefined,
      selected: option.currentValue === value.value,
      action: {
        type: "config" as const,
        configId: option.id,
        value: value.value,
      },
    }));
  });
}

export function buildAcpPaletteItems({
  commands,
  modes,
  configOptions,
}: {
  commands: AvailableCommand[];
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
}): AcpPaletteItem[] {
  return [
    ...commands.map((command) => ({
      id: `command:${command.name}`,
      group: "Agent commands" as const,
      label: command.name.startsWith("/") ? command.name : `/${command.name}`,
      description: command.description,
      action: { type: "insert_prompt" as const, prompt: commandPrompt(command) },
    })),
    ...(modes?.availableModes.map((mode) => ({
      id: `mode:${mode.id}`,
      group: "Modes" as const,
      label: mode.name,
      description: mode.description ?? undefined,
      selected: modes.currentModeId === mode.id,
      action: { type: "mode" as const, modeId: mode.id },
    })) ?? []),
    ...configOptions.flatMap(configItems),
    {
      id: "powerhouse:terminal",
      group: "Powerhouse",
      label: "Open terminal",
      description: "Switch this chat to the agent's native CLI",
      action: { type: "terminal" },
    },
  ];
}

export function filterAcpPaletteItems(
  items: AcpPaletteItem[],
  query: string,
): AcpPaletteItem[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;
  return items.filter((item) => {
    const haystack = `${item.group} ${item.label} ${item.description ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
