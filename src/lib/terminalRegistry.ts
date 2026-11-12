// Lives OUTSIDE React: xterm instances survive re-renders and tab switches.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { ptyKill, ptyReadTranscript, ptyResize, ptySpawn, ptyWrite } from "./ipc";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  dispose: () => void;
}

const registry = new Map<string, Entry>();

// Chats created this session auto-launch their terminal; chats restored from
// disk stay idle until the user clicks Start (no agent-launch storm on boot).
const autoSpawn = new Set<string>();

export const markAutoSpawn = (chatId: string) => autoSpawn.add(chatId);
export const consumeAutoSpawn = (chatId: string) => autoSpawn.delete(chatId);
export const hasTerminal = (chatId: string) => registry.has(chatId);

const TERMINAL_ANSI_COLORS = {
  black: "#22252c",
  red: "#f47067",
  green: "#57ab5a",
  yellow: "#c69026",
  blue: "#539bf5",
  magenta: "#b083f0",
  cyan: "#39c5cf",
  white: "#d6d9e0",
  brightBlack: "#545d68",
  brightRed: "#ff938a",
  brightGreen: "#6bc46d",
  brightYellow: "#daaa3f",
  brightBlue: "#6cb6ff",
  brightMagenta: "#dcbdfb",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f3f6",
};

/** Resolve the same semantic colors as the app instead of a separate terminal skin. */
function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    ...TERMINAL_ANSI_COLORS,
    ...(style.colorScheme === "light" ? {
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#9a6700",
      blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#7d4e00",
      brightBlue: "#0550ae", brightMagenta: "#6639ba", brightCyan: "#055d69", brightWhite: "#24292f",
    } : {}),
    background: color("--terminal-background"),
    foreground: color("--terminal-foreground"),
    cursor: color("--terminal-cursor"),
    cursorAccent: color("--terminal-background"),
    selectionBackground: color("--terminal-selection-background"),
  };
}

export function syncTerminalThemes() {
  if (registry.size === 0) return;
  const theme = terminalTheme();
  for (const { term } of registry.values()) term.options.theme = theme;
}

/** Builds and registers an xterm instance with no PTY wiring. Its `dispose`
 *  only tears down the terminal; `spawnTerminal` replaces it once it wires
 *  live subscriptions. */
function createTerminal(chatId: string, container: HTMLElement): Entry {
  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    cursorBlink: true,
    macOptionIsMeta: true,
    scrollback: 10_000,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Let app-level shortcuts (Cmd+D/T/W, Cmd+Shift+Backspace, Ctrl+`) through
  // instead of xterm eating them (and, for Ctrl+`, sending a stray control
  // sequence to the PTY).
  term.attachCustomKeyEventHandler((e) => {
    if (
      e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      ["d", "t", "w", ","].includes(e.key.toLowerCase())
    ) {
      return false;
    }
    if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === "Backspace") {
      return false;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Backquote") {
      return false;
    }
    return true;
  });
  term.open(container);
  fit.fit();

  const entry: Entry = { term, fit, dispose: () => term.dispose() };
  registry.set(chatId, entry);
  return entry;
}

/**
 * Restores a chat's recorded output into a read-only terminal, with no PTY.
 * Returns true when history was shown (or a terminal already exists). No-op if
 * there's nothing recorded.
 */
export async function replayTranscript(
  chatId: string,
  container: HTMLElement,
): Promise<boolean> {
  if (registry.has(chatId)) return true;
  const data = await ptyReadTranscript(chatId);
  if (!data) return false;
  const entry = createTerminal(chatId, container);
  entry.term.options.disableStdin = true; // read-only history view
  entry.term.write(data);
  return true;
}

export async function spawnTerminal(opts: {
  chatId: string;
  cwd: string;
  agentCmd?: string;
  container: HTMLElement;
  onExit: () => void;
  resetTranscript?: boolean;
}): Promise<void> {
  const { chatId, cwd, agentCmd, container, onExit, resetTranscript = false } = opts;

  // Reuse a replay-only entry if present (clear its history, re-enable input);
  // otherwise build a fresh terminal.
  let entry = registry.get(chatId);
  if (entry) {
    entry.term.reset();
    entry.term.options.disableStdin = false;
  } else {
    entry = createTerminal(chatId, container);
  }
  const { term } = entry;

  // Subscribe before spawning so the first output chunk is never missed.
  const unlistenOut = await listen<string>(`pty-out-${chatId}`, (e) =>
    term.write(e.payload),
  );
  const unlistenExit = await listen(`pty-exit-${chatId}`, () => onExit());
  const dataSub = term.onData((d) => void ptyWrite(chatId, d));
  const resizeSub = term.onResize(({ cols, rows }) => void ptyResize(chatId, cols, rows));

  entry.dispose = () => {
    unlistenOut();
    unlistenExit();
    dataSub.dispose();
    resizeSub.dispose();
    term.dispose();
  };

  try {
    await ptySpawn(chatId, cwd, term.cols, term.rows, agentCmd, resetTranscript);
    term.focus();
  } catch (err) {
    term.write(`\r\n\x1b[31mFailed to start shell: ${String(err)}\x1b[0m\r\n`);
    onExit();
  }
}

export function disposeTerminal(chatId: string, { kill = true } = {}) {
  const entry = registry.get(chatId);
  if (!entry) return;
  registry.delete(chatId);
  entry.dispose();
  if (kill) void ptyKill(chatId).catch(() => {});
}

/** Safe to call any time; never fit a hidden terminal (0×0 would corrupt the grid). */
export function fitTerminal(chatId: string) {
  const entry = registry.get(chatId);
  if (!entry) return;
  const el = entry.term.element;
  if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
  try {
    entry.fit.fit();
  } catch {
    // container mid-layout; the next resize observation will retry
  }
}

export function focusTerminal(chatId: string) {
  registry.get(chatId)?.term.focus();
}
