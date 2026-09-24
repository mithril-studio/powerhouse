import { useCallback, useEffect, useMemo, useState } from "react";
import { memorySettingsOf, useAppStore } from "../../store/appStore";
import {
  activeNotes,
  autoPromotes,
  discardInboxNote,
  GLOBAL_PROJECT,
  inboxNotes,
  memoryCall,
  memoryProjectSlug,
  memoryServerEnsure,
  parseRecent,
  parseSearchResults,
  promoteInboxNote,
  rankNotes,
  saveInboxNote,
  stripFrontmatter,
  type BriefNote,
  type MemoryServerStatus,
  type MemorySettings,
} from "../../lib/memory";

/**
 * The Memory page: the same notes the agents see, browsable and readable.
 * Talks to the memory server over the same MCP endpoint the agents use, so
 * what is shown here is exactly what a session can retrieve. Editing is
 * still done in the files (they are the source of truth) — this page is the
 * window, the foundation to iterate on.
 *
 * Two views. Inbox shows notes agents and run checkpoints wrote but that no
 * human has approved yet: approve moves the note into its type folder, discard
 * deletes it, and the body is editable first. Corrections auto-promote on load,
 * since the user already said it. Browse shows the approved tree.
 */
async function fetchInbox(
  memory: MemorySettings,
  project: string,
): Promise<{ pending: BriefNote[]; promoted: number }> {
  const raw = await memoryCall(memory, "recent_activity", {
    project,
    timeframe: "3650d",
    page_size: 100,
    output_format: "json",
  });
  let pending = inboxNotes(rankNotes(parseRecent(raw, project), 100));
  const corrections = pending.filter((n) => autoPromotes(n.type));
  for (const note of corrections) {
    await promoteInboxNote(memory, note).catch(() => {});
  }
  if (corrections.length > 0) pending = pending.filter((n) => !autoPromotes(n.type));
  return { pending, promoted: corrections.length };
}

export function MemoryPage() {
  const open = useAppStore((s) => s.memoryOpen);
  const closeMemory = useAppStore((s) => s.closeMemory);
  const settings = useAppStore((s) => s.settings);
  const repos = useAppStore((s) => s.repos);
  const memory = useMemo(() => memorySettingsOf(settings), [settings]);

  const projects = useMemo(() => {
    const slugs = repos.map((r) => memoryProjectSlug(r.name));
    return [GLOBAL_PROJECT, ...slugs.filter((s, i) => s !== GLOBAL_PROJECT && slugs.indexOf(s) === i)];
  }, [repos]);

  const [project, setProject] = useState<string>(GLOBAL_PROJECT);
  const [view, setView] = useState<"inbox" | "browse">("inbox");
  const [status, setStatus] = useState<MemoryServerStatus | "checking" | "off">("checking");
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<BriefNote[]>([]);
  const [inbox, setInbox] = useState<BriefNote[]>([]);
  const [selected, setSelected] = useState<BriefNote | null>(null);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    if (!memory.enabled) return;
    setLoading(true);
    setError(null);
    try {
      const q = query.trim();
      const raw = q
        ? await memoryCall(memory, "search_notes", { project, query: q, page_size: 40, output_format: "json" })
        : await memoryCall(memory, "recent_activity", { project, timeframe: "365d", page_size: 40, output_format: "json" });
      const parsed = q ? parseSearchResults(raw, project) : parseRecent(raw, project);
      // Browse is the approved tree; the inbox has its own view.
      setNotes(activeNotes(rankNotes(parsed, 40)));
    } catch (cause) {
      setError(String(cause));
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [memory, project, query]);

  const loadInbox = useCallback(async () => {
    if (!memory.enabled) return;
    try {
      const { pending, promoted } = await fetchInbox(memory, project);
      setInbox(pending);
      setNotice(promoted > 0 ? `Auto-approved ${promoted} correction${promoted === 1 ? "" : "s"}.` : null);
    } catch (cause) {
      setError(String(cause));
      setInbox([]);
    }
  }, [memory, project]);

  const approve = useCallback(
    async (nt: BriefNote) => {
      setActing(true);
      setError(null);
      try {
        await promoteInboxNote(memory, nt);
        if (selected?.permalink === nt.permalink) setSelected(null);
        await loadInbox();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setActing(false);
      }
    },
    [memory, selected, loadInbox],
  );

  const discard = useCallback(
    async (nt: BriefNote) => {
      setActing(true);
      setError(null);
      try {
        await discardInboxNote(memory, nt);
        if (selected?.permalink === nt.permalink) setSelected(null);
        await loadInbox();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setActing(false);
      }
    },
    [memory, selected, loadInbox],
  );

  const saveDraft = useCallback(async () => {
    if (!selected || draft == null) return;
    setActing(true);
    setError(null);
    try {
      await saveInboxNote(memory, selected, draft);
      setBody(draft);
      setDraft(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setActing(false);
    }
  }, [memory, selected, draft]);

  useEffect(() => {
    if (!open) return;
    if (!memory.enabled) {
      setStatus("off");
      return;
    }
    setStatus("checking");
    memoryServerEnsure(memory)
      .then((s) => {
        setStatus(s);
        void load();
        void loadInbox();
      })
      .catch((cause) => {
        setStatus("failed");
        setError(String(cause));
      });
    // `load` is intentionally not a dep: the ensure step gates the first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, memory]);

  useEffect(() => {
    if (!open || status === "checking" || status === "off") return;
    const handle = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(handle);
  }, [open, status, load, query]);

  // The inbox has no query; reload it when the server is ready or the project
  // changes so a freshly written note or checkpoint shows up on return.
  useEffect(() => {
    if (!open || status === "checking" || status === "off") return;
    void loadInbox();
  }, [open, status, loadInbox]);

  useEffect(() => {
    setDraft(null);
    if (!selected) {
      setBody("");
      return;
    }
    let cancelled = false;
    memoryCall<{ content?: string }>(memory, "read_note", {
      project: selected.project,
      identifier: selected.permalink,
      output_format: "json",
    })
      .then((raw) => {
        if (!cancelled) setBody(stripFrontmatter(raw?.content ?? ""));
      })
      .catch((cause) => {
        if (!cancelled) setBody(`(could not read note: ${String(cause)})`);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, memory]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMemory();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, closeMemory]);

  if (!open) return null;

  const statusLabel: Record<typeof status, string> = {
    checking: "connecting…",
    off: "memory is off (Settings → Memory)",
    external: `connected · ${memory.url}`,
    supervised: `local server running · ${memory.url}`,
    unreachable: `unreachable · ${memory.url}`,
    failed: "local server failed to start",
  };
  const healthy = status === "external" || status === "supervised";
  const list = view === "inbox" ? inbox : notes;

  return (
    <div className="fixed inset-y-0 right-0 left-60 z-40 flex flex-col border-l border-border bg-background">
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center justify-end px-3">
        <button
          onClick={() => closeMemory()}
          title="Close memory"
          aria-label="Close memory"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-8 pb-8 pt-2">
          <div className="mb-3 flex items-center justify-between">
            <h1 className="text-lg font-semibold text-foreground">Memory</h1>
            <span className={`text-[11px] ${healthy ? "text-muted-foreground" : "text-destructive"}`}>
              <span
                className={`mr-1.5 inline-block size-1.5 rounded-full align-middle ${
                  healthy ? "bg-success" : status === "checking" ? "bg-muted-foreground" : "bg-destructive"
                }`}
              />
              {statusLabel[status]}
            </span>
          </div>

          <div className="mb-3 flex items-center justify-between gap-4 border-b border-border">
            <div className="flex gap-4">
              {projects.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setProject(p);
                    setSelected(null);
                  }}
                  className={`-mb-px border-b pb-1.5 text-[11px] font-semibold uppercase tracking-wider ${
                    project === p
                      ? "border-accent-brand text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="mb-1 flex items-center gap-1 rounded-lg bg-muted p-0.5">
              {(["inbox", "browse"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setView(v);
                    setSelected(null);
                  }}
                  className={`rounded-md px-2 py-0.5 text-[11px] font-medium capitalize ${
                    view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {v}
                  {v === "inbox" && inbox.length > 0 ? ` (${inbox.length})` : ""}
                </button>
              ))}
            </div>
          </div>

          {view === "browse" && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${project}… (empty = recent)`}
              className="mb-3 h-8 w-full rounded-lg border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          )}

          {notice && <p className="mb-2 text-[11px] text-muted-foreground">{notice}</p>}
          {error && <p className="mb-2 text-[11px] text-destructive">{error}</p>}

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,22rem)_1fr] gap-4">
            <ul className="min-h-0 overflow-y-auto rounded-xl border border-border">
              {list.length === 0 && !loading && (
                <li className="px-3 py-4 text-[11px] text-muted-foreground">
                  {view === "inbox"
                    ? `Inbox empty — nothing waiting for approval in ${project}.`
                    : query
                      ? "No matches."
                      : `Nothing recorded in ${project} yet.`}
                </li>
              )}
              {list.map((n) => (
                <li
                  key={`${n.project}:${n.permalink}`}
                  className={`border-b border-border ${selected?.permalink === n.permalink ? "bg-muted" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(n)}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-muted"
                  >
                    <span className="text-xs text-foreground">{n.title}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {n.type || "note"}
                      {n.updatedAt ? ` · ${n.updatedAt.slice(0, 10)}` : ""}
                    </span>
                  </button>
                  {view === "inbox" && (
                    <div className="flex gap-2 px-3 pb-2">
                      <button
                        type="button"
                        disabled={acting}
                        onClick={() => void approve(n)}
                        className="rounded-md bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success hover:bg-success/25 disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={acting}
                        onClick={() => void discard(n)}
                        className="rounded-md bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
                      >
                        Discard
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="min-h-0 overflow-y-auto rounded-xl border border-border bg-card p-4">
              {selected ? (
                <>
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-foreground">{selected.title}</p>
                    {view === "inbox" && (
                      <div className="flex shrink-0 gap-2">
                        {draft == null ? (
                          <button
                            type="button"
                            onClick={() => setDraft(body)}
                            className="rounded-md border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            Edit
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={acting}
                              onClick={() => void saveDraft()}
                              className="rounded-md border border-border px-2 py-0.5 text-[10px] text-foreground hover:bg-muted disabled:opacity-50"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setDraft(null)}
                              className="rounded-md border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="mb-3 text-[10px] text-muted-foreground">{selected.permalink}</p>
                  {draft == null ? (
                    <pre className="whitespace-pre-wrap font-sans text-xs leading-5 text-foreground">{body}</pre>
                  ) : (
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      className="min-h-64 w-full resize-y rounded-lg border border-input bg-background p-2 font-mono text-xs leading-5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                  )}
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {view === "inbox"
                    ? "Select a pending note to review. Approve moves it into memory; discard drops it. Corrections are approved automatically."
                    : "Select a note. Notes are Markdown files under ~/.powerhouse/memory; edit them there, the index follows."}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
