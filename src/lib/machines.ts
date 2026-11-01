// The Machines tab: typed IPC for `src-tauri/src/cloud/machines.rs` and the
// small rules the pane renders by. Shells are `boxd connect` in a bottom-panel
// terminal; boxd brings its own SSH, so nothing here touches keys.
import { invoke } from "@tauri-apps/api/core";
import type { MachineEditor } from "../store/appStore";

export interface MachineRow {
  name: string;
  status: string;
  url: string | null;
  size: string | null;
  /** Named `ph-…`: Powerhouse may delete it. */
  owned: boolean;
}

export const machinesList = () => invoke<MachineRow[]>("machines_list");
export const machineSuggestName = (branch: string) => invoke<string>("machine_suggest_name", { branch });
export const machineCreate = (name: string) => invoke<MachineRow>("machine_create", { name });
export const machineStart = (vm: string) => invoke<void>("machine_start", { vm });
export const machineStop = (vm: string) => invoke<void>("machine_stop", { vm });
export const machineRemove = (vm: string, confirm: string) => invoke<void>("machine_remove", { vm, confirm });
export const machineOpenInEditor = (vm: string, editor: MachineEditor) =>
  invoke<void>("machine_open_in_editor", { vm, editor });

export const EDITOR_LABEL: Record<MachineEditor, string> = { vscode: "VS Code", cursor: "Cursor" };

/** The command a VM terminal runs; names are validated by the backend list. */
export const connectCommand = (vm: string) => `boxd connect ${vm}`;

export const isRunning = (status: string) => status === "running";

/** Stopped, hibernated and paused machines can be started; anything mid-transition can't. */
export const canStart = (status: string) => ["stopped", "hibernated", "paused", "suspended"].includes(status);

export function statusTone(status: string): "on" | "busy" | "off" {
  if (isRunning(status)) return "on";
  if (["starting", "creating", "stopping", "provisioning", "booting"].includes(status)) return "busy";
  return "off";
}

/** "3 running · 17 total". */
export function machinesSummary(rows: MachineRow[]): string {
  const running = rows.filter((r) => isRunning(r.status)).length;
  return `${running} running · ${rows.length} total`;
}

export type MachinesProblem = "cli-missing" | "signed-out" | null;

/** Errors the pane answers with a fix instead of the raw message. */
export function machinesProblem(error: string | null): MachinesProblem {
  if (!error) return null;
  if (error.includes("boxd CLI is not installed")) return "cli-missing";
  if (error.includes("not authenticated")) return "signed-out";
  return null;
}
