// Hierarchical command palette. The root shows a few grouped entries; picking a
// "Session" entry drills into a focused submenu instead of dumping every model
// and mode value at once. Everything is plain, serializable data so it can be
// unit-tested without a live agent; the component turns leaf actions into calls.
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import {
  resolveModels,
  resolveModes,
  resolveReasoning,
  type AgentControlState,
  type ApplyOp,
  type Selector,
  type Unsupported,
} from "./agentControls";

export type PaletteAction =
  | { type: "submenu"; view: PaletteView }
  | { type: "apply"; op: ApplyOp }
  | { type: "insert_prompt"; prompt: string }
  | { type: "native_cli" }
  | { type: "restart" };

export interface PaletteItem {
  id: string;
  label: string;
  description?: string;
  /** Right-aligned current value (submenus) or affordance. */
  hint?: string;
  selected?: boolean;
  action: PaletteAction;
}

export interface PaletteGroup {
  heading: string;
  items: PaletteItem[];
}

export interface PaletteView {
  /** Undefined at the root; set for a submenu title. */
  title?: string;
  groups: PaletteGroup[];
}

function commandPrompt(command: AvailableCommand): string {
  const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
  return command.input ? `${name} ` : name;
}

/** Turns a resolved selector into a "Change X…" root entry that opens a submenu. */
function selectorEntry(
  selector: Selector | Unsupported,
  id: string,
  verb: string,
): PaletteItem | null {
  if (!selector.supported) return null;
  const view: PaletteView = {
    title: selector.title,
    groups: [
      {
        heading: selector.title,
        items: selector.options.map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description,
          selected: option.active,
          action: { type: "apply", op: option.apply },
        })),
      },
    ],
  };
  return {
    id,
    label: `${verb}…`,
    hint: selector.current?.label,
    action: { type: "submenu", view },
  };
}

export function buildPalette(state: AgentControlState): PaletteView {
  const session = [
    selectorEntry(resolveModes(state), "session:mode", "Switch mode"),
    selectorEntry(resolveModels(state), "session:model", "Change model"),
    selectorEntry(resolveReasoning(state), "session:reasoning", "Change reasoning"),
  ].filter((item): item is PaletteItem => item !== null);

  const commands: PaletteItem[] = state.commands.map((command) => {
    const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
    return {
      id: `command:${command.name}`,
      label: name,
      description: command.description,
      action: { type: "insert_prompt", prompt: commandPrompt(command) },
    };
  });

  const powerhouse: PaletteItem[] = [
    {
      id: "powerhouse:native-cli",
      label: "Open native CLI",
      description: "Launch this agent's CLI in the bottom panel — ACP stays alive",
      action: { type: "native_cli" },
    },
    {
      id: "powerhouse:restart",
      label: "Restart ACP session",
      description: "Reconnect the agent from scratch",
      action: { type: "restart" },
    },
  ];

  const groups: PaletteGroup[] = [];
  if (session.length > 0) groups.push({ heading: "Session", items: session });
  if (commands.length > 0) groups.push({ heading: "Agent commands", items: commands });
  groups.push({ heading: "Powerhouse", items: powerhouse });
  return { groups };
}

/** Filters items within a single view across label, description, hint, and group. */
export function filterPalette(view: PaletteView, query: string): PaletteView {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return view;
  const groups = view.groups
    .map((group) => ({
      heading: group.heading,
      items: group.items.filter((item) => {
        const haystack =
          `${group.heading} ${item.label} ${item.description ?? ""} ${item.hint ?? ""}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      }),
    }))
    .filter((group) => group.items.length > 0);
  return { title: view.title, groups };
}

/** Flattens a view's items in display order (used for keyboard navigation). */
export function flattenView(view: PaletteView): PaletteItem[] {
  return view.groups.flatMap((group) => group.items);
}
