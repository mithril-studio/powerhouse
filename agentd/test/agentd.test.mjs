import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENTD = path.join(here, "..", "ph-agentd.mjs");
const FAKE = path.join(here, "fake-agent.mjs");

let root;
let clients;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pha-"));
  clients = [];
});

afterEach(async () => {
  for (const c of clients) c.proc.kill("SIGKILL");
  for (const chat of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const pidFile = path.join(root, chat, "serve.pid");
    if (fs.existsSync(pidFile)) {
      try {
        process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGTERM");
      } catch {}
    }
  }
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(root, { recursive: true, force: true });
});

function attachProcess(chat = "c1", agent = [process.execPath, FAKE]) {
  return spawn(
    process.execPath,
    [AGENTD, "attach", "--chat", chat, "--spawn", "detached", "--", ...agent],
    { env: { ...process.env, PH_AGENTD_DIR: root, PH_AGENTD_KEEPALIVE_URL: "" }, stdio: ["pipe", "pipe", "pipe"] },
  );
}

/** A raw JSON-RPC client over one `attach` process. Ids start at 0, as a fresh SDK client's do. */
function connect(chat = "c1") {
  const proc = attachProcess(chat);
  const inbox = [];
  const waiters = [];
  let exitCode;
  const exited = new Promise((r) =>
    proc.on("exit", (code) => {
      exitCode = code;
      r(code);
    }),
  );
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  let nextId = 0;
  const client = {
    proc,
    inbox,
    exited,
    get exitCode() {
      return exitCode;
    },
    send: (msg) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"),
    wait(match, ms = 5000) {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error("timed out waiting for a message")), ms);
      });
    },
    async request(method, params) {
      const id = nextId++;
      client.send({ id, method, params });
      const res = await client.wait((m) => m.id === id && m.method === undefined);
      if (res.error) throw new Error(res.error.message);
      return res.result;
    },
    chunks: () =>
      inbox
        .filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((m) => m.params.update.content.text),
    seqs: () => inbox.filter((m) => m.method === "session/update").map((m) => m.params._meta["ph/seq"]),
    drop: () => {
      proc.kill("SIGKILL");
      return exited;
    },
  };
  clients.push(client);
  return client;
}

const init = (c) => c.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
const text = (t) => [{ type: "text", text: t }];
const chunkCount = (c, n) => () => c.chunks().length >= n;
async function until(cond, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("ph-agentd", () => {
  it("relays a first session end to end and stamps updates with seq", async () => {
    const a = connect();
    const info = await init(a);
    expect(info.protocolVersion).toBe(1);
    const { sessionId } = await a.request("session/new", { cwd: "/", mcpServers: [] });
    const done = await a.request("session/prompt", { sessionId, prompt: text("count 3") });
    expect(done.stopReason).toBe("end_turn");
    expect(a.chunks()).toEqual(["1", "2", "3"]);
    expect(a.seqs()).toEqual([1, 2, 3]);
  });

  it("survives a dropped client mid-turn and replays exactly what was missed", async () => {
    const a = connect();
    await init(a);
    const { sessionId } = await a.request("session/new", { cwd: "/", mcpServers: [] });
    a.send({ id: 99, method: "session/prompt", params: { sessionId, prompt: text("count 12") } });
    await until(chunkCount(a, 3));
    await a.drop();
    const seen = Math.max(...a.seqs());

    await new Promise((r) => setTimeout(r, 150)); // the turn keeps going without a client
    const b = connect();
    await init(b); // answered from cache: the fake agent errors on a second initialize
    const resumed = await b.request("session/resume", {
      sessionId,
      cwd: "/",
      mcpServers: [],
      _meta: { "ph/fromSeq": seen },
    });
    expect(resumed.modes.currentModeId).toBe("default");
    expect(resumed.configOptions[0].currentValue).toBe("opus");
    await b.wait((m) => m.method === "_ph/turn" && m.params.running === true);
    const end = await b.wait((m) => m.method === "_ph/turn" && m.params.running === false);
    expect(end.params).toMatchObject({ sessionId, stopReason: "end_turn" });

    const all = [...a.chunks(), ...b.chunks()];
    expect(all).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
    expect(b.seqs()[0]).toBe(seen + 1);
    // The prompt response itself belonged to the dropped client and is not delivered.
    expect(b.inbox.some((m) => m.id === 99)).toBe(false);
  });

  it("tells a resuming client how a turn that ended while it was away finished", async () => {
    const a = connect();
    await init(a);
    const { sessionId } = await a.request("session/new", { cwd: "/", mcpServers: [] });
    a.send({ id: 9, method: "session/prompt", params: { sessionId, prompt: text("count 3") } });
    await until(chunkCount(a, 1));
    await a.drop();
    await new Promise((r) => setTimeout(r, 300)); // the turn ends with no client

    const b = connect();
    await init(b);
    await b.request("session/resume", { sessionId, cwd: "/", mcpServers: [], _meta: { "ph/fromSeq": 1 } });
    const turn = await b.wait((m) => m.method === "_ph/turn");
    expect(turn.params).toEqual({ sessionId, running: false, stopReason: "end_turn" });
    expect(b.chunks()).toEqual(["2", "3"]);
  });

  it("sends no turn state on resume when the session never had a turn", async () => {
    const a = connect();
    await init(a);
    const { sessionId } = await a.request("session/new", { cwd: "/", mcpServers: [] });
    await a.drop();
    const b = connect();
    await init(b);
    await b.request("session/resume", { sessionId, cwd: "/", mcpServers: [] });
    await new Promise((r) => setTimeout(r, 100));
    expect(b.inbox.some((m) => m.method === "_ph/turn")).toBe(false);
  });

  it("routes responses by remapped ids when a new client reuses ids", async () => {
    const a = connect();
    await init(a); // id 0
    const { sessionId } = await a.request("session/new", { cwd: "/", mcpServers: [] }); // id 1
    a.send({ id: 2, method: "session/prompt", params: { sessionId, prompt: text("count 6") } });
    await until(chunkCount(a, 1));
    await a.drop();

    const b = connect();
    await init(b); // id 0 again
    await b.request("session/resume", { sessionId, cwd: "/", mcpServers: [], _meta: { "ph/fromSeq": 0 } }); // id 1
    await b.wait((m) => m.method === "_ph/turn" && m.params.running === false);
    const done = await b.request("session/prompt", { sessionId, prompt: text("count 2") }); // id 2
    expect(done.stopReason).toBe("end_turn");
    expect(b.inbox.filter((m) => m.id === 2 && m.method === undefined)).toHaveLength(1);
  });

  it("holds a permission request while no client is attached and re-sends it on resume", async () => {
    const a = connect();
    await init(a);
    const { sessionId } = await a.request("session/new", { cwd: "/", mcpServers: [] });
    a.send({ id: 50, method: "session/prompt", params: { sessionId, prompt: text("ask") } });
    await a.wait((m) => m.method === "session/request_permission");
    await a.drop();

    const b = connect();
    await init(b);
    await b.request("session/resume", { sessionId, cwd: "/", mcpServers: [], _meta: { "ph/fromSeq": 0 } });
    const ask = await b.wait((m) => m.method === "session/request_permission");
    b.send({ id: ask.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    await b.wait((m) => m.method === "_ph/turn" && m.params.running === false);
    expect(b.chunks()).toContain("answer:allow");
  });

  it("keeps the mode a dropped client set", async () => {
    const a = connect();
    await init(a);
    const { sessionId } = await a.request("session/new", { cwd: "/", mcpServers: [] });
    await a.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    await a.drop();

    const b = connect();
    await init(b);
    const resumed = await b.request("session/resume", { sessionId, cwd: "/", mcpServers: [] });
    expect(resumed.modes.currentModeId).toBe("bypassPermissions");
  });

  it("lets a new client replace the attached one", async () => {
    const a = connect();
    await init(a);
    const b = connect();
    await init(b);
    expect(await a.exited).toBe(0);
    const { sessionId } = await b.request("session/new", { cwd: "/", mcpServers: [] });
    expect(sessionId).toBe("s1");
  });

  it("forwards resume for a session it does not hold to the agent", async () => {
    const a = connect();
    await init(a);
    await expect(a.request("session/resume", { sessionId: "nope", cwd: "/", mcpServers: [] })).rejects.toThrow(
      /unknown session/,
    );
  });

  it("exits with the agent, removes the socket, and starts a fresh agent on the next attach", async () => {
    const a = connect();
    await init(a);
    const { sessionId } = await a.request("session/new", { cwd: "/", mcpServers: [] });
    a.send({ id: 7, method: "session/prompt", params: { sessionId, prompt: text("exit") } });
    await a.exited;
    await until(() => !fs.existsSync(path.join(root, "c1", "sock")));

    const b = connect();
    await init(b); // a fresh agent accepts initialize again
    const fresh = await b.request("session/new", { cwd: "/", mcpServers: [] });
    expect(fresh.sessionId).toBe("s1");
  });

  it("fails fast with the reason when the agent cannot start", async () => {
    const started = Date.now();
    const proc = attachProcess("c2", ["/nonexistent/agent"]);
    clients.push({ proc });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((r) => proc.on("exit", r));
    expect(code).toBe(2);
    expect(stderr).toMatch(/cannot start agent: spawn \/nonexistent\/agent ENOENT/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("works with the ACP SDK client: _meta seq and _ph/turn reach the app's handlers", async () => {
    const { client, methods, ndJsonStream } = await import("@agentclientprotocol/sdk");
    const sdkConnect = () => {
      const proc = attachProcess();
      clients.push({ proc });
      const updates = [];
      const turns = [];
      const app = client({ name: "test" })
        .onNotification(methods.client.session.update, ({ params }) => {
          updates.push(params);
        })
        .onNotification("_ph/turn", (p) => p, ({ params }) => {
          turns.push(params);
        });
      const connection = app.connect(
        ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout)),
      );
      return { proc, connection, updates, turns };
    };
    const initialize = (c) =>
      c.connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });

    const a = sdkConnect();
    await initialize(a);
    const { sessionId } = await a.connection.agent.request(methods.agent.session.new, { cwd: "/", mcpServers: [] });
    void a.connection.agent.request("session/prompt", { sessionId, prompt: text("count 10") }).catch(() => {});
    await until(() => a.updates.length >= 2);
    a.proc.kill("SIGKILL");
    const seen = Math.max(...a.updates.map((u) => u._meta["ph/seq"]));

    const b = sdkConnect();
    await initialize(b);
    await b.connection.agent.request(methods.agent.session.resume, {
      sessionId,
      cwd: "/",
      mcpServers: [],
      _meta: { "ph/fromSeq": seen },
    });
    await until(() => b.turns.some((t) => t.running === false));
    const texts = [...a.updates, ...b.updates].map((u) => u.update.content.text);
    expect(texts).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
    expect(b.turns[0]).toMatchObject({ sessionId, running: true });
  });
});

describe("Relay.busy", () => {
  it("is true only while a turn is in flight", async () => {
    const { Relay } = await import("../ph-agentd.mjs");
    const toAgent = [];
    const relay = new Relay((m) => toAgent.push(m));
    const link = relay.attach(() => {});
    link.receive({ jsonrpc: "2.0", id: 0, method: "session/new", params: {} });
    relay.fromAgent({ jsonrpc: "2.0", id: toAgent[0].id, result: { sessionId: "s1" } });
    expect(relay.busy()).toBe(false);
    link.receive({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s1", prompt: [] } });
    expect(relay.busy()).toBe(true);
    relay.fromAgent({ jsonrpc: "2.0", id: toAgent[1].id, result: { stopReason: "end_turn" } });
    expect(relay.busy()).toBe(false);
  });
});

describe("readLines", () => {
  it("survives an error on its stream (a client resetting the connection)", async () => {
    const { readLines } = await import("../ph-agentd.mjs");
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    const got = [];
    readLines(stream, (m) => got.push(m));
    stream.write('{"a":1}\n');
    await new Promise((r) => setTimeout(r, 10));
    const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(() => stream.destroy(err)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ a: 1 }]);
  });
});
