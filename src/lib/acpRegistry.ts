import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentCapabilities,
  ClientConnection,
  Implementation,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModeState,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { acpKill, acpSpawn, acpWrite } from "./ipc";

export interface AcpStartResult {
  sessionId: string;
  resumed: boolean;
  capabilities: AgentCapabilities;
  agentInfo?: Implementation | null;
  modes?: SessionModeState | null;
}

export interface AcpCallbacks {
  onUpdate: (update: SessionUpdate) => void;
  onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  onModeChange?: (modeId: string) => void;
  onStderr?: (chunk: string) => void;
  onExit: (code: number | null) => void;
}

interface Entry {
  connection: ClientConnection;
  sessionId?: string;
  unlisten: UnlistenFn[];
  closeInput: () => void;
}

const registry = new Map<string, Entry>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
  resumeSessionId?: string;
  callbacks: AcpCallbacks;
}): Promise<AcpStartResult> {
  const { chatId, cwd, command, resumeSessionId, callbacks } = opts;
  await disposeAcp(chatId);
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
    });
  const connection = app.connect(ndJsonStream(output, input));
  const entry: Entry = {
    connection,
    unlisten: [unlistenOut, unlistenStderr, unlistenExit],
    closeInput,
  };
  registry.set(chatId, entry);

  try {
    await acpSpawn(chatId, cwd, command);
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
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
    let resumed = false;

    if (resumeSessionId && capabilities.sessionCapabilities?.resume != null) {
      try {
        const response = await connection.agent.request(methods.agent.session.resume, {
          sessionId: resumeSessionId,
          cwd,
          mcpServers: [],
        });
        sessionId = resumeSessionId;
        modes = response.modes;
        resumed = true;
      } catch {
        const response = await connection.agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
        });
        sessionId = response.sessionId;
        modes = response.modes;
      }
    } else {
      const response = await connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      sessionId = response.sessionId;
      modes = response.modes;
    }

    entry.sessionId = sessionId;
    return {
      sessionId,
      resumed,
      capabilities,
      agentInfo: initialized.agentInfo,
      modes,
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

export function sendAcpPrompt(chatId: string, text: string): Promise<PromptResponse> {
  const entry = getEntry(chatId);
  return entry.connection.agent.request("session/prompt", {
    sessionId: entry.sessionId!,
    prompt: [{ type: "text", text }],
  });
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
