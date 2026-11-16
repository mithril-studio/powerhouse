// End-to-end check of ph-agentd on a real boxd VM with the real Claude ACP
// adapter: start a turn, kill the connection mid-turn (what a closed laptop
// does), reconnect, and verify the turn finished and nothing was lost.
//
//   node agentd/test/vm-e2e.mjs
//
// Needs the `boxd` CLI logged in, and a Claude token on the VM (boxd env
// CLAUDE_CODE_OAUTH_TOKEN). Creates and always destroys `ph-e2e-agentd-*`.
// About 2 minutes and a few cents.
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";

const ADAPTER = "@agentclientprotocol/claude-agent-acp@0.107.0";
const here = path.dirname(fileURLToPath(import.meta.url));
const vm = `ph-e2e-agentd-${Date.now().toString(36)}`;
const boxd = (...args) => execFileSync("boxd", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const exec = (cmd) => boxd("machine", "exec", vm, "--", "bash", "-lc", cmd);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
async function until(cond, ms, what) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}

function connect() {
  const proc = spawn(
    "boxd",
    ["machine", "exec", vm, "--", "bash", "-lc",
      "exec node ~/ph-agentd.mjs attach --chat e2e --cwd /home/boxd/repo -- claude-agent-acp"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const updates = [];
  const turns = [];
  const app = client({ name: "vm-e2e" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => ({
      outcome: { outcome: "selected", optionId: params.options.find((o) => o.kind.startsWith("allow")).optionId },
    }))
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params);
    })
    .onNotification("_ph/turn", (p) => p, ({ params }) => {
      turns.push(params);
    });
  const connection = app.connect(ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout)));
  return { proc, connection, updates, turns };
}

const initialize = (c) =>
  c.connection.agent.request(methods.agent.initialize, {
    protocolVersion: 1,
    clientCapabilities: { session: { configOptions: { boolean: {} } } },
  });

const textOf = (updates) =>
  updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => u.update.content.text ?? "")
    .join("");

let failed = false;
try {
  let t = Date.now();
  boxd("new", vm, "--json");
  log(`created ${vm} in ${Date.now() - t} ms`);

  boxd("machine", "cp", path.join(here, "..", "ph-agentd.mjs"), `${vm}:/home/boxd/ph-agentd.mjs`);
  t = Date.now();
  exec(`npm install -g --silent ${ADAPTER} && mkdir -p ~/repo && cd ~/repo && git init -q`);
  log(`installed the adapter in ${Date.now() - t} ms`);

  const a = connect();
  t = Date.now();
  await initialize(a);
  const { sessionId } = await a.connection.agent.request(methods.agent.session.new, {
    cwd: "/home/boxd/repo",
    mcpServers: [],
  });
  log(`session ${sessionId} ready in ${Date.now() - t} ms`);
  await a.connection.agent.request(methods.agent.session.setMode, { sessionId, modeId: "bypassPermissions" });

  const marker = "/home/boxd/repo/ticks.txt";
  void a.connection.agent
    .request("session/prompt", {
      sessionId,
      prompt: [{
        type: "text",
        text: `Use two separate Bash tool calls, one after the other. First: for i in $(seq 1 5); do echo tick $i >> ${marker}; sleep 2; done. Second: echo second >> ${marker}. Then reply with the single word FINISHED.`,
      }],
    })
    .catch(() => {});

  await until(
    () => a.updates.some((u) => u.update.sessionUpdate === "tool_call"),
    90_000,
    "the agent starting its tool call",
  );
  await sleep(3000);
  const seen = Math.max(...a.updates.map((u) => u._meta["ph/seq"]));
  a.proc.kill("SIGKILL");
  log(`dropped the connection at seq ${seen}, mid-command`);

  await sleep(25000); // long enough for the first command to end and the second to run
  const ticksWhileAway = Number(exec(`wc -l < ${marker}`).trim());
  log(`ticks written while disconnected: ${ticksWhileAway}`);

  const b = connect();
  await initialize(b);
  const resumed = await b.connection.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/home/boxd/repo",
    mcpServers: [],
    _meta: { "ph/fromSeq": seen },
  });
  const resumedReplay = b.updates.length;
  log(`resumed; mode ${resumed.modes?.currentModeId}, ${resumedReplay} updates replayed`);

  await until(() => b.turns.some((x) => x.running === false), 120_000, "the turn ending");
  const end = b.turns.find((x) => x.running === false);
  const seqs = b.updates.map((u) => u._meta["ph/seq"]);
  const gaps = seqs.some((s, i) => s !== seen + 1 + i);
  const finalText = textOf([...a.updates, ...b.updates]);
  const ticks = Number(exec(`wc -l < ${marker}`).trim());

  const checks = {
    "turn state reported on resume": b.turns.length > 0,
    "turn ended with end_turn": end.stopReason === "end_turn",
    "replay starts right after the last seen update": seqs[0] === seen + 1,
    "no gaps or duplicates in seq": !gaps,
    "work continued while disconnected": ticksWhileAway > 0,
    "updates made while disconnected were replayed": b.updates.length > 0 && resumedReplay > 0,
    "both commands completed (6 lines)": ticks === 6,
    "agent replied FINISHED": /FINISHED/.test(finalText),
    "mode survived the reconnect": resumed.modes?.currentModeId === "bypassPermissions",
  };
  for (const [name, ok] of Object.entries(checks)) {
    log(`${ok ? "PASS" : "FAIL"} ${name}`);
    if (!ok) failed = true;
  }
  b.proc.kill("SIGKILL");
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  try {
    boxd("machine", "rm", vm, "-y");
    log(`destroyed ${vm}`);
  } catch (err) {
    console.error(`could not destroy ${vm}; remove it by hand: ${err.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
