import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import { resolveChatTransport, useAppStore } from "../store/appStore";
import { createHandoffChat } from "./actions";
import { sendAcpPrompt } from "./acpRegistry";
import { appendSystemMessage, appendUserMessage } from "./acpTranscript";
import {
  handoffEnsureCommands,
  ptyWrite,
  type HandoffEvent,
} from "./ipc";

/** Kept in sync with `src-tauri/src/handoff.rs` (HANDOFF_INSTRUCTION). */
export const HANDOFF_INSTRUCTION =
  "Write a complete handoff document to `.powerhouse/handoff-<YYYYMMDD-HHMMSS>.md` " +
  "(relative to the repo root) covering: the task and goal, work completed, key " +
  "decisions and why, files touched, current state, immediate next steps, and " +
  "gotchas. Write it in a single operation and end the file with the exact line " +
  "`<!-- handoff-complete -->`.";

const HANDOFF_TIMEOUT_MS = 180_000;

function cancelHandoff(branchId: string) {
  const timer = useAppStore.getState().pendingHandoff[branchId];
  if (timer !== undefined) window.clearTimeout(timer);
  useAppStore.getState().clearPendingHandoff(branchId);
}

/**
 * Types the handoff instruction into the branch's active chat and submits it.
 * Clicking again while pending cancels. Works with any agent (plain-text prompt).
 */
export async function startHandoff(repoId: string, branchId: string) {
  const s = useAppStore.getState();
  if (branchId in s.pendingHandoff) {
    cancelHandoff(branchId);
    return;
  }

  const branch = s.repos
    .find((r) => r.id === repoId)
    ?.branches.find((b) => b.id === branchId);
  const chat = branch?.chats.find((candidate) => candidate.id === branch.activeChatId);
  if (!branch || !chat) return;
  const chatId = chat.id;

  if ((s.chatStatus[chatId] ?? "idle") !== "running") {
    await message("The active chat has no running agent to hand off from.", {
      title: "Handoff",
      kind: "warning",
    });
    return;
  }

  const timer = window.setTimeout(async () => {
    useAppStore.getState().clearPendingHandoff(branchId);
    await message(
      "Handoff timed out — no handoff document appeared. The agent may have already exited to the shell.",
      { title: "Handoff", kind: "warning" },
    );
  }, HANDOFF_TIMEOUT_MS);
  s.setPendingHandoff(branchId, timer);

  if (resolveChatTransport(s.settings, chat) === "acp") {
    s.updateChatAcpTranscript(repoId, branchId, chatId, (items) =>
      appendUserMessage(items, HANDOFF_INSTRUCTION),
    );
    void sendAcpPrompt(chatId, [{ type: "text", text: HANDOFF_INSTRUCTION }]).catch(async (error) => {
      cancelHandoff(branchId);
      useAppStore.getState().updateChatAcpTranscript(repoId, branchId, chatId, (items) =>
        appendSystemMessage(items, `Handoff failed: ${String(error)}`, "error"),
      );
      await message(String(error), { title: "Handoff failed", kind: "error" });
    });
    return;
  }

  // Separate writes around TUI paste-heuristics: a rapid burst that includes the
  // trailing \r is treated as a paste and never submits.
  await ptyWrite(chatId, HANDOFF_INSTRUCTION);
  await new Promise((r) => setTimeout(r, 150));
  await ptyWrite(chatId, "\r");
}

// Dedupe: the poll watcher could report the same path twice across ticks.
const handledPaths = new Set<string>();

function onHandoffCreated(ev: HandoffEvent) {
  if (handledPaths.has(ev.path)) return;
  handledPaths.add(ev.path);

  const repo = useAppStore
    .getState()
    .repos.find((r) => r.branches.some((b) => b.id === ev.branchId));
  if (!repo) return; // branch was deleted

  cancelHandoff(ev.branchId);
  createHandoffChat(repo.id, ev.branchId, ev.relPath);
}

let inited = false;

/** Called once at app boot: seed slash-commands + the global handoff listener. */
export async function initHandoff() {
  if (inited) return;
  inited = true;
  await handoffEnsureCommands().catch(() => {});
  await listen<HandoffEvent>("handoff-created", (e) => onHandoffCreated(e.payload));
}
