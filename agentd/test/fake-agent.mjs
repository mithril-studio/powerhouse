// A scripted ACP agent for ph-agentd tests. Newline-delimited JSON-RPC on
// stdin/stdout.
//
// - A second `initialize` is an error: ph-agentd must send exactly one.
// - `session/prompt` with text "count N" streams N chunks ("1".."N"), 40 ms
//   apart, then ends the turn. Text "ask" first asks for permission and puts
//   the chosen option id in a chunk. Text "exit" exits the process with code 3.
// - `session/set_mode` answers and reports `current_mode_update`.
// - `session/cancel` ends the running turn with `cancelled`.
import readline from "node:readline";

let initialized = false;
let nextRequest = 100;
const waiting = new Map(); // our request id -> resolve
const turns = new Map(); // sessionId -> { cancelled, id }
let sessions = 0;

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const chunk = (sessionId, text) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(sessionId) {
  const id = nextRequest++;
  send({
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId: "t1", title: "Run a command" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function prompt(id, params) {
  const { sessionId } = params;
  const text = params.prompt.map((b) => b.text ?? "").join("");
  const turn = { cancelled: false };
  turns.set(sessionId, turn);
  if (text === "exit") process.exit(3);
  if (text === "ask") {
    const answer = await ask(sessionId);
    chunk(sessionId, `answer:${answer.outcome?.optionId ?? answer.outcome?.outcome}`);
  }
  const count = Number(/^count (\d+)$/.exec(text)?.[1] ?? 0);
  for (let i = 1; i <= count; i++) {
    if (turn.cancelled) break;
    await sleep(40);
    chunk(sessionId, String(i));
  }
  turns.delete(sessionId);
  send({ id, result: { stopReason: turn.cancelled ? "cancelled" : "end_turn" } });
}

const modes = (current) => ({
  currentModeId: current,
  availableModes: [
    { id: "default", name: "Default" },
    { id: "bypassPermissions", name: "Bypass" },
  ],
});

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case "initialize":
      if (initialized) {
        send({ id: msg.id, error: { code: -32600, message: "initialized twice" } });
        return;
      }
      initialized = true;
      send({
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } },
      });
      return;
    case "session/new":
      send({
        id: msg.id,
        result: {
          sessionId: `s${++sessions}`,
          modes: modes("default"),
          configOptions: [{ id: "model", category: "model", currentValue: "opus", type: "select", options: [] }],
        },
      });
      return;
    case "session/resume":
      send({ id: msg.id, error: { code: -32002, message: `unknown session ${msg.params.sessionId}` } });
      return;
    case "session/set_mode":
      send({ id: msg.id, result: {} });
      update(msg.params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: msg.params.modeId });
      return;
    case "session/prompt":
      void prompt(msg.id, msg.params);
      return;
    case "session/cancel": {
      const turn = turns.get(msg.params.sessionId);
      if (turn) turn.cancelled = true;
      return;
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `no ${msg.method}` } });
  }
});
