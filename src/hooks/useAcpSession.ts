import { useEffect } from "react";
import {
  resolveAgent,
  useAppStore,
  type Branch,
  type Chat,
} from "../store/appStore";
import {
  applySessionControl,
  cancelSession,
  EMPTY_SESSION,
  noteSession,
  restartSession,
  sendSessionPrompt,
  startSession,
  useSessions,
} from "../lib/agentSessionService";
import { consumeAutoSpawn } from "../lib/terminalRegistry";
import type { ApplyOp } from "../lib/agentControls";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";

/** The view subscribes; a chat has exactly one service owner across all views. */
export function useAcpSession({
  chat,
  active,
}: {
  repoId: string;
  branch: Branch;
  chat: Chat;
  active: boolean;
}) {
  const settings = useAppStore((s) => s.settings);
  const profile = resolveAgent(settings, chat.agentId);
  const state = useSessions((s) => s.sessions[chat.id] ?? EMPTY_SESSION);
  const start = (resume: boolean) =>
    startSession(chat.id, resume).catch(() => {});
  useEffect(() => {
    if (active && state.connection === "idle" && consumeAutoSpawn(chat.id))
      void startSession(chat.id, Boolean(chat.agentSessionId)).catch(() => {});
  }, [active, chat.id, chat.agentSessionId, state.connection]);
  const permission = state.permissions[0] ?? null;
  const thinking = state.configOptions.find(
    (o) => o.category === "thought_level" && o.type === "select",
  )?.currentValue;
  return {
    ...state,
    profile,
    agentLabel: state === EMPTY_SESSION ? profile.name : state.agentLabel,
    permission,
    controlState: {
      modes: state.modes,
      configOptions: state.configOptions,
      commands: state.commands,
    },
    thinkingLevel: typeof thinking === "string" ? thinking : undefined,
    start,
    submitPrompt: (text: string) =>
      sendSessionPrompt(chat.id, text).catch(() => {}),
    cancel: () => cancelSession(chat.id),
    restart: () => {
      void restartSession(chat.id).catch(() => {});
    },
    applyOp: (op: ApplyOp) => {
      void applySessionControl(chat.id, op);
    },
    resolvePermission: (response: RequestPermissionResponse) =>
      permission?.resolve(response),
    note: (text: string) => noteSession(chat.id, text),
  };
}
