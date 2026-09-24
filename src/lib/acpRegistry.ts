import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentCapabilities,
  AvailableCommand,
  ClientConnection,
  ContentBlock,
  Implementation,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { acpKill, acpSpawn, acpWrite } from "./ipc";

export interface AcpStartResult {
  sessionId: string;
  resumed: boolean;
  capabilities: AgentCapabilities;
  agentInfo?: Implementation | null;
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

export interface AcpCallbacks {
  onUpdate: (update: SessionUpdate) => void;
  onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  onModeChange?: (modeId: string) => void;
  onConfigOptionsChange?: (options: SessionConfigOption[]) => void;
  onAvailableCommandsChange?: (commands: AvailableCommand[]) => void;
  onSessionReplayChange?: (replaying: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onStderr?: (chunk: string) => void;
  onExit: (code: number | null) => void;
}

interface Entry {
  connection: ClientConnection;
  callbacks: AcpCallbacks;
  sessionId?: string;
  unlisten: UnlistenFn[];
  closeInput: () => void;
  busy: boolean;
}

const registry = new Map<string, Entry>();
const encoder = new TextEncoder();

export const hasAcpSession = (chatId: string) => registry.has(chatId);

export async function disposeAcp(chatId: string): Promise<void> {
  const entry = registry.get(chatId);
  if (!entry) {
    await acpKill(chatId).catch(() => {});
    return;
  }
  registry.delete(chatId);
  entry.connection.close();
  entry.closeInput();
  entry.unlisten.forEach((stop) => stop());
  await acpKill(chatId).catch(() => {});
}

export async function startAcp(opts: {
  chatId: string;
  cwd: string;
  command: string;
  /** Extra environment for the agent process. */
  env?: Record<string, string>;
  resumeSessionId?: string;
  callbacks: AcpCallbacks;
}): Promise<AcpStartResult> {
  const { chatId, cwd, command, env, resumeSessionId, callbacks } = opts;
  await disposeAcp(chatId);
  const decoder = new TextDecoder();
  const { PROTOCOL_VERSION, client, methods, ndJsonStream } = await import(
    "@agentclientprotocol/sdk"
  );

  let inputController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let inputClosed = false;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      inputController = controller;
    },
  });
  const closeInput = () => {
    if (inputClosed) return;
    inputClosed = true;
    inputController?.close();
  };
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return acpWrite(chatId, decoder.decode(chunk, { stream: true }));
    },
  });

  const unlistenOut = await listen<string>(`acp-out-${chatId}`, (event) => {
    if (!inputClosed) inputController?.enqueue(encoder.encode(event.payload));
  });
  const unlistenStderr = await listen<string>(`acp-stderr-${chatId}`, (event) => {
    callbacks.onStderr?.(event.payload);
  });
  const unlistenExit = await listen<number | null>(`acp-exit-${chatId}`, (event) => {
    closeInput();
    callbacks.onExit(event.payload);
  });

  const app = client({ name: "Powerhouse" })
    .onRequest(methods.client.session.requestPermission, ({ params }) =>
      callbacks.onPermission(params),
    )
    .onNotification(methods.client.session.update, ({ params }) => {
      callbacks.onUpdate(params.update);
      if (params.update.sessionUpdate === "current_mode_update") {
        callbacks.onModeChange?.(params.update.currentModeId);
      }
      if (params.update.sessionUpdate === "config_option_update") {
        callbacks.onConfigOptionsChange?.(params.update.configOptions);
      }
      if (params.update.sessionUpdate === "available_commands_update") {
        callbacks.onAvailableCommandsChange?.(params.update.availableCommands);
      }
    });
  const connection = app.connect(ndJsonStream(output, input));
  const entry: Entry = {
    connection,
    callbacks,
    unlisten: [unlistenOut, unlistenStderr, unlistenExit],
    closeInput,
    busy: false,
  };
  registry.set(chatId, entry);

  try {
    await acpSpawn(chatId, cwd, command, env);
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
      clientInfo: { name: "Powerhouse", version: "0.1.0" },
    });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `ACP protocol ${initialized.protocolVersion} is not supported (expected ${PROTOCOL_VERSION})`,
      );
    }

    const capabilities = initialized.agentCapabilities ?? {};
    let sessionId: string;
    let modes: SessionModeState | null | undefined;
    let configOptions: SessionConfigOption[] | null | undefined;
    let resumed = false;

    const canResume = capabilities.sessionCapabilities?.resume != null;
    const canLoad = capabilities.loadSession === true;
    if (resumeSessionId && (canResume || canLoad)) {
      try {
        if (!canResume) callbacks.onSessionReplayChange?.(true);
        const response = canResume
          ? await connection.agent.request(methods.agent.session.resume, {
              sessionId: resumeSessionId,
              cwd,
              mcpServers: [],
            })
          : await connection.agent.request(methods.agent.session.load, {
              sessionId: resumeSessionId,
              cwd,
              mcpServers: [],
            });
        if (!canResume) callbacks.onSessionReplayChange?.(false);
        sessionId = resumeSessionId;
        modes = response.modes;
        configOptions = response.configOptions;
        resumed = true;
      } catch {
        callbacks.onSessionReplayChange?.(false);
        const response = await connection.agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
        });
        sessionId = response.sessionId;
        modes = response.modes;
        configOptions = response.configOptions;
      }
    } else {
      const response = await connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      sessionId = response.sessionId;
      modes = response.modes;
      configOptions = response.configOptions;
    }

    entry.sessionId = sessionId;
    return {
      sessionId,
      resumed,
      capabilities,
      agentInfo: initialized.agentInfo,
      modes,
      configOptions,
    };
  } catch (error) {
    await disposeAcp(chatId);
    throw error;
  }
}

function getEntry(chatId: string): Entry {
  const entry = registry.get(chatId);
  if (!entry?.sessionId) throw new Error("ACP chat is not connected");
  return entry;
}

/** Sends one turn. `prompt` is the ordered content: text and/or image blocks. */
export async function sendAcpPrompt(
  chatId: string,
  prompt: ContentBlock[],
): Promise<PromptResponse> {
  const entry = getEntry(chatId);
  if (entry.busy) throw new Error("ACP agent is already working");
  if (prompt.length === 0) throw new Error("Prompt is empty");
  entry.busy = true;
  entry.callbacks.onBusyChange?.(true);
  try {
    return await entry.connection.agent.request("session/prompt", {
      sessionId: entry.sessionId!,
      prompt,
    });
  } finally {
    entry.busy = false;
    entry.callbacks.onBusyChange?.(false);
  }
}

export function cancelAcpPrompt(chatId: string): Promise<void> {
  const entry = getEntry(chatId);
  return entry.connection.agent.notify("session/cancel", {
    sessionId: entry.sessionId!,
  });
}

export function setAcpMode(chatId: string, modeId: string): Promise<unknown> {
  const entry = getEntry(chatId);
  return entry.connection.agent.request("session/set_mode", {
    sessionId: entry.sessionId!,
    modeId,
  });
}

export async function setAcpConfigOption(
  chatId: string,
  configId: string,
  value: string | boolean,
): Promise<SessionConfigOption[]> {
  const entry = getEntry(chatId);
  const option =
    typeof value === "boolean"
      ? { sessionId: entry.sessionId!, configId, type: "boolean" as const, value }
      : { sessionId: entry.sessionId!, configId, value };
  const response = (await entry.connection.agent.request(
    "session/set_config_option",
    option,
  )) as SetSessionConfigOptionResponse;
  return response.configOptions;
}
