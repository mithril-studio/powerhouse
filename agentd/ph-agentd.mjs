#!/usr/bin/env node
// ph-agentd: keeps one chat's ACP agent alive on a VM while the desktop app
// comes and goes. No dependencies; runs on the Node that every boxd VM has.
//
//   ph-agentd serve  --chat <id> [--cwd <dir>] -- <agent argv...>
//   ph-agentd attach --chat <id> [--cwd <dir>] [--spawn systemd|detached] -- <agent argv...>
//
// `attach` is what the app runs over `boxd machine exec`: it bridges stdin and
// stdout to the chat's socket, starting `serve` first when none is running, so
// the first connect and every reconnect are the same call.
//
// `serve` owns the agent process and speaks ACP (newline-delimited JSON-RPC)
// on both sides. It is transparent except for these rules, which let a client
// disconnect at any point and pick up exactly where it left off:
//
// - Every `session/update` sent to a client carries `_meta["ph/seq"]`, a
//   number that increases by one per update. Updates are kept in memory.
// - `initialize` reaches the agent once. Later clients get the cached result.
// - `session/resume` for a session this agent already holds is answered here:
//   updates with seq > `_meta["ph/fromSeq"]` (default 0, i.e. all) are
//   replayed, held agent requests are re-sent, then the response carries the
//   current modes and config options. Unknown sessions go to the agent.
// - Client request ids are remapped, so a new client can reuse ids. A
//   response for a client that has gone is dropped.
// - `_ph/turn` notifications tell a client about prompts it did not send.
//   Every local resume ends with one: `{sessionId, running: true}` while a
//   turn is in flight, else `{sessionId, running: false, stopReason}` for the
//   last turn (omitted if the session never had one). A turn that ends after
//   the resume, but was sent by an earlier client, reports
//   `{running: false, stopReason}` when it ends.
// - Agent requests (permission prompts) are held until a client answers; a
//   client that resumes gets every unanswered one again.
// - One client at a time: a new connection replaces the current one.
// - When the agent exits, serve exits with its code and removes the socket.
// - While any turn runs, serve makes a small outbound request every minute:
//   boxd suspends a VM after a stretch of idle network, and a silent build
//   inside a turn must not count as idle. `PH_AGENTD_KEEPALIVE_URL` overrides
//   the target; an empty value disables it.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const SEQ = "ph/seq";
const FROM_SEQ = "ph/fromSeq";
const TURN = "_ph/turn";
const ATTACH_WAIT_MS = 15_000;
const KEEPALIVE_MS = 60_000;
const KEEPALIVE_URL = process.env.PH_AGENTD_KEEPALIVE_URL ?? "https://boxd.sh";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, agent: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") {
      opts.agent = rest.slice(i + 1);
      break;
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const value = rest[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    opts[arg.slice(2)] = value;
  }
  if (!opts.chat || !/^[A-Za-z0-9_-]{1,64}$/.test(opts.chat)) {
    throw new Error("--chat <id> is required (letters, digits, _ and -)");
  }
  return opts;
}

/** Per-chat state directory. `PH_AGENTD_DIR` overrides the root (tests). */
export function chatDir(chat) {
  const root = process.env.PH_AGENTD_DIR || path.join(os.homedir(), ".ph", "agents");
  return path.join(root, chat);
}

function withMeta(params, key, value) {
  const base = params && typeof params === "object" ? params : {};
  return { ...base, _meta: { ...(base._meta ?? {}), [key]: value } };
}

/**
 * The ACP relay, independent of sockets so it can be tested with plain
 * functions. `toAgent(msg)` writes to the agent; `attach(send)` connects a
 * client and returns `{ receive, detach }`.
 */
export class Relay {
  constructor(toAgent) {
    this.toAgent = toAgent;
    this.client = null; // { gen, send }
    this.gen = 0;
    this.nextId = 1;
    this.inflight = new Map(); // internal id -> { gen, id, method, params }
    this.initialized = null; // cached initialize result
    this.initWaiters = []; // clients waiting for the first initialize: { gen, id }
    this.initSent = false;
    this.updates = []; // { seq, msg }
    this.seq = 0;
    this.sessions = new Map(); // sessionId -> { modes, configOptions, models, prompt }
    this.held = new Map(); // agent request id -> msg
  }

  /** Whether any session has a turn in flight. */
  busy() {
    for (const s of this.sessions.values()) if (s.prompt !== null) return true;
    return false;
  }

  attach(send) {
    const gen = ++this.gen;
    this.client = { gen, send };
    return {
      receive: (msg) => {
        if (this.client?.gen === gen) this.fromClient(msg);
      },
      detach: () => {
        if (this.client?.gen === gen) this.client = null;
      },
    };
  }

  toClient(msg) {
    this.client?.send(msg);
  }

  session(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { modes: null, configOptions: null, models: null, prompt: null, lastTurn: null };
      this.sessions.set(id, s);
    }
    return s;
  }

  remember(sessionId, result) {
    if (!sessionId || !result || typeof result !== "object") return;
    const s = this.session(sessionId);
    if ("modes" in result) s.modes = result.modes ?? null;
    if ("configOptions" in result) s.configOptions = result.configOptions ?? null;
    if ("models" in result) s.models = result.models ?? null;
  }

  fromClient(msg) {
    const isRequest = msg.method !== undefined && msg.id !== undefined;
    const isResponse = msg.method === undefined && msg.id !== undefined;

    if (isResponse) {
      // A client's answer to an agent request (permission prompt).
      if (this.held.delete(msg.id)) this.toAgent(msg);
      return;
    }
    if (!isRequest) {
      this.toAgent(msg); // notification, e.g. session/cancel
      return;
    }

    const gen = this.client.gen;
    if (msg.method === "initialize") {
      if (this.initialized) {
        this.toClient({ jsonrpc: "2.0", id: msg.id, result: this.initialized });
        return;
      }
      this.initWaiters.push({ gen, id: msg.id });
      if (this.initSent) return;
      this.initSent = true;
    }

    if (msg.method === "session/resume") {
      const sessionId = msg.params?.sessionId;
      const s = this.sessions.get(sessionId);
      if (s) {
        this.resumeLocally(msg, sessionId, s);
        return;
      }
    }

    const internal = this.nextId++;
    this.inflight.set(internal, { gen, id: msg.id, method: msg.method, params: msg.params });
    if (msg.method === "session/prompt" && msg.params?.sessionId) {
      this.session(msg.params.sessionId).prompt = internal;
    }
    this.toAgent({ ...msg, id: internal });
  }

  resumeLocally(msg, sessionId, s) {
    const from = Number(msg.params?._meta?.[FROM_SEQ] ?? 0);
    for (const { seq, msg: update } of this.updates) {
      if (seq > from && update.params?.sessionId === sessionId) this.toClient(update);
    }
    for (const request of this.held.values()) this.toClient(request);
    const result = {};
    if (s.modes) result.modes = s.modes;
    if (s.configOptions) result.configOptions = s.configOptions;
    if (s.models) result.models = s.models;
    this.toClient({ jsonrpc: "2.0", id: msg.id, result });
    if (s.prompt !== null) {
      this.toClient({ jsonrpc: "2.0", method: TURN, params: { sessionId, running: true } });
    } else if (s.lastTurn) {
      this.toClient({ jsonrpc: "2.0", method: TURN, params: { sessionId, running: false, ...s.lastTurn } });
    }
  }

  fromAgent(msg) {
    const isRequest = msg.method !== undefined && msg.id !== undefined;
    const isNotification = msg.method !== undefined && msg.id === undefined;

    if (isRequest) {
      this.held.set(msg.id, msg);
      this.toClient(msg);
      return;
    }

    if (isNotification) {
      if (msg.method === "session/update") {
        const seq = ++this.seq;
        const stamped = { ...msg, params: withMeta(msg.params, SEQ, seq) };
        this.updates.push({ seq, msg: stamped });
        this.track(msg.params);
        this.toClient(stamped);
        return;
      }
      this.toClient(msg);
      return;
    }

    // A response to a request we forwarded.
    const origin = this.inflight.get(msg.id);
    if (!origin) return;
    this.inflight.delete(msg.id);

    if (origin.method === "initialize") {
      if (msg.result) this.initialized = msg.result;
      else this.initSent = false; // let the next client try again
      const waiters = this.initWaiters;
      this.initWaiters = [];
      for (const w of waiters) {
        if (this.client?.gen === w.gen) this.toClient({ ...msg, id: w.id });
      }
      return;
    }

    const sessionId = msg.result?.sessionId ?? origin.params?.sessionId;
    if (msg.result) {
      switch (origin.method) {
        case "session/new":
        case "session/load":
        case "session/resume":
        case "session/fork":
          this.remember(sessionId, msg.result);
          break;
        case "session/set_config_option":
          this.remember(sessionId, { configOptions: msg.result.configOptions });
          break;
        case "session/set_mode": {
          const s = this.sessions.get(sessionId);
          if (s?.modes) s.modes = { ...s.modes, currentModeId: origin.params.modeId };
          break;
        }
      }
    }

    let turnEnded = false;
    const ending = {
      stopReason: msg.result?.stopReason ?? null,
      ...(msg.error ? { error: msg.error } : {}),
    };
    if (origin.method === "session/prompt") {
      const s = this.sessions.get(origin.params?.sessionId);
      if (s && s.prompt === msg.id) s.prompt = null;
      if (s) s.lastTurn = ending;
      turnEnded = true;
    }

    if (this.client?.gen === origin.gen) {
      this.toClient({ ...msg, id: origin.id });
    } else if (turnEnded) {
      this.toClient({
        jsonrpc: "2.0",
        method: TURN,
        params: { sessionId: origin.params?.sessionId, running: false, ...ending },
      });
    }
  }

  track(params) {
    const update = params?.update;
    const s = params?.sessionId ? this.sessions.get(params.sessionId) : null;
    if (!update || !s) return;
    if (update.sessionUpdate === "current_mode_update" && s.modes) {
      s.modes = { ...s.modes, currentModeId: update.currentModeId };
    }
    if (update.sessionUpdate === "config_option_update") {
      s.configOptions = update.configOptions;
    }
  }
}

/**
 * Calls `onMessage` with each parsed JSON line from a readable stream. Stream
 * errors end the reading quietly: readline re-emits its input's errors (a
 * client vanishing gives ECONNRESET on Linux), and unhandled they would kill
 * the process that keeps the agent alive.
 */
export function readLines(stream, onMessage) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  rl.on("error", () => rl.close());
  stream.on("error", () => {});
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`ph-agentd: dropped a line that is not JSON\n`);
      return;
    }
    onMessage(msg);
  });
  return rl;
}

function socketAlive(sock) {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}

async function serve(opts) {
  if (opts.agent.length === 0) throw new Error("serve needs the agent command after --");
  const dir = chatDir(opts.chat);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sock = path.join(dir, "sock");
  if (fs.existsSync(sock)) {
    if (await socketAlive(sock)) return 0; // another serve owns this chat
    fs.unlinkSync(sock);
  }

  const stderrPath = path.join(dir, "agent.stderr.log");
  // Last resort: serve exists to keep the agent alive, so a bug in the relay
  // is logged rather than allowed to take the agent down with it.
  process.on("uncaughtException", (err) => {
    fs.appendFileSync(stderrPath, `ph-agentd: uncaught: ${err.stack ?? err}\n`);
  });
  const stderrLog = fs.openSync(stderrPath, "a");
  // What `attach` reads to fail fast instead of waiting out ATTACH_WAIT_MS.
  const fatal = (message) => {
    fs.appendFileSync(stderrPath, `ph-agentd: ${message}\n`);
    fs.writeFileSync(path.join(dir, "serve.error"), message);
  };
  // Global npm installs (the ACP adapter) sit next to the node running us,
  // which a login shell's PATH can miss when node is reached via a symlink.
  const PATH = [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(":");
  const agent = spawn(opts.agent[0], opts.agent.slice(1), {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, PATH },
    stdio: ["pipe", "pipe", stderrLog],
  });
  agent.stdin.on("error", () => {});

  const relay = new Relay((msg) => agent.stdin.write(JSON.stringify(msg) + "\n"));
  if (KEEPALIVE_URL) {
    setInterval(() => {
      if (!relay.busy()) return;
      fetch(KEEPALIVE_URL, { method: "HEAD", signal: AbortSignal.timeout(10_000) }).catch(() => {});
    }, KEEPALIVE_MS).unref();
  }
  readLines(agent.stdout, (msg) => relay.fromAgent(msg));

  let current = null; // the attached socket
  const server = net.createServer((conn) => {
    if (current) current.destroy();
    current = conn;
    conn.on("error", () => {});
    const link = relay.attach((msg) => {
      if (!conn.destroyed) conn.write(JSON.stringify(msg) + "\n");
    });
    readLines(conn, (msg) => link.receive(msg));
    conn.on("close", () => {
      link.detach();
      if (current === conn) current = null;
    });
  });

  return await new Promise((resolve, reject) => {
    server.once("error", (err) => {
      fatal(`cannot listen on ${sock}: ${err.message}`);
      agent.kill("SIGTERM");
      reject(err);
    });
    server.listen(sock, () => {
      fs.chmodSync(sock, 0o600);
      fs.writeFileSync(path.join(dir, "serve.pid"), String(process.pid));
    });
    const shutdown = (code) => {
      server.close();
      current?.end();
      try {
        fs.unlinkSync(sock);
      } catch {}
      fs.writeFileSync(path.join(dir, "serve.exit"), String(code));
      resolve(code);
    };
    agent.on("exit", (code, signal) => shutdown(code ?? (signal ? 128 : 1)));
    agent.on("error", (err) => {
      fatal(`cannot start agent: ${err.message}`);
      shutdown(127);
    });
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.on(sig, () => agent.kill("SIGTERM"));
    }
  });
}

// Environment that belongs to the exec session, not to the agent.
const SESSION_ENV = new Set([
  "_", "PWD", "OLDPWD", "SHLVL", "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID",
  "MANAGERPID", "NOTIFY_SOCKET", "LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES",
]);

function startServe(opts) {
  const dir = chatDir(opts.chat);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of ["serve.error", "serve.exit"]) fs.rmSync(path.join(dir, f), { force: true });
  const self = process.argv[1];
  const args = [self, "serve", "--chat", opts.chat];
  if (opts.cwd) args.push("--cwd", opts.cwd);
  args.push("--", ...opts.agent);
  const mode =
    opts.spawn ||
    (spawnSync("systemd-run", ["--version"], { stdio: "ignore" }).status === 0
      ? "systemd"
      : "detached");
  if (mode === "systemd") {
    // A user unit outlives the exec session that started it, but starts with a
    // bare environment: hand it ours (PATH from the login shell, the tokens
    // boxd injects). `--setenv=NAME` copies the value without putting it on
    // the command line. A second attach racing this one fails on the
    // duplicate unit name, which is fine: it then connects to the first one.
    const env = Object.keys(process.env)
      .filter((k) => !SESSION_ENV.has(k) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map((k) => `--setenv=${k}`);
    const run = spawnSync(
      "systemd-run",
      ["--user", "--collect", `--unit=ph-agent-${opts.chat}`, ...env, process.execPath, ...args],
      { encoding: "utf8" },
    );
    if (run.status !== 0 && !/already (exists|loaded)/i.test(run.stderr)) {
      throw new Error(`systemd-run failed: ${run.stderr.trim()}`);
    }
  } else {
    const log = fs.openSync(path.join(dir, "serve.log"), "a");
    spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log] }).unref();
  }
}

async function attach(opts) {
  const sock = path.join(chatDir(opts.chat), "sock");
  if (!(await socketAlive(sock))) {
    if (opts.agent.length === 0) throw new Error("no agent running, and no command given to start one");
    startServe(opts);
    const deadline = Date.now() + ATTACH_WAIT_MS;
    const dir = chatDir(opts.chat);
    const read = (f) => {
      try {
        return fs.readFileSync(path.join(dir, f), "utf8").trim();
      } catch {
        return null;
      }
    };
    while (!(await socketAlive(sock))) {
      const error = read("serve.error");
      if (error) throw new Error(error);
      const exit = read("serve.exit");
      if (exit !== null) {
        const tail = (read("agent.stderr.log") ?? "").split("\n").slice(-5).join("\n");
        throw new Error(`agent exited with code ${exit} while starting\n${tail}`);
      }
      if (Date.now() > deadline) throw new Error(`agent did not start; see ${dir}/agent.stderr.log`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return await new Promise((resolve) => {
    const conn = net.connect(sock);
    conn.on("error", (err) => {
      process.stderr.write(`ph-agentd: ${err.message}\n`);
      resolve(1);
    });
    conn.on("connect", () => {
      process.stdin.pipe(conn);
      conn.pipe(process.stdout);
    });
    // The app went away (EPIPE): end quietly; serve keeps the agent.
    process.stdout.on("error", () => resolve(0));
    process.stdin.on("error", () => resolve(0));
    process.stdin.on("end", () => conn.end());
    conn.on("close", () => resolve(0));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === "serve") return await serve(opts);
  if (opts.command === "attach") return await attach(opts);
  throw new Error("usage: ph-agentd serve|attach --chat <id> [--cwd dir] -- <agent argv>");
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
const isMain =
  process.argv[1] &&
  realpath(path.resolve(process.argv[1])) === realpath(new URL(import.meta.url).pathname);
if (isMain) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`ph-agentd: ${err.message}\n`);
      process.exit(2);
    },
  );
}
