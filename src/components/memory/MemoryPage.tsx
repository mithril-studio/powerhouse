import { useCallback, useEffect, useMemo, useState } from "react";
import { memorySettingsOf, useAppStore } from "../../store/appStore";
import {
  activeNotes,
  autoPromotes,
  deleteMemoryProject,
  discardInboxNote,
  GLOBAL_PROJECT,
  inboxNotes,
  listMemoryProjects,
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
    // The server rejects any timeframe over a year; 365d is its ceiling.
    timeframe: "365d",
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

/** The memory browser lives in Settings → Memory (`embedded`). */
export function MemoryPage({ embedded = false }: { embedded?: boolean } = {}) {
  const open = useAppStore((s) => s.memoryOpen) || embedded;
  const closeMemory = useAppStore((s) => s.closeMemory);
  const settings = useAppStore((s) => s.settings);
  const repos = useAppStore((s) => s.repos);
  const memory = useMemo(() => memorySettingsOf(settings), [settings]);

  const [serverProjects, setServerProjects] = useState<string[]>([]);

  // Tabs are the repos you have added plus whatever the memory server itself
  // tracks — so orphaned projects (a repo since removed) still show up and can
  // be cleaned up here. Global always leads and is never listed twice.
  const projects = useMemo(() => {
    const all = [...repos.map((r) => memoryProjectSlug(r.name)), ...serverProjects].filter(
      (s) => s !== GLOBAL_PROJECT,
    );
    return [GLOBAL_PROJECT, ...all.filter((s, i) => all.indexOf(s) === i)];
  }, [repos, serverProjects]);

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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  const loadProjects = useCallback(async () => {
    if (!memory.enabled) return;
    try {
      setServerProjects(await listMemoryProjects(memory));
    } catch {
      // Leave the repo-derived tabs as the fallback; the page still works.
    }
  }, [memory]);

  const deleteProject = useCallback(async () => {
    if (project === GLOBAL_PROJECT) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMemoryProject(memory, project);
      setConfirmDelete(false);
      setSelected(null);
      setProject(GLOBAL_PROJECT);
      await loadProjects();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDeleting(false);
    }
  }, [memory, project, loadProjects]);

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
        void loadProjects();
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
    if (!open || embedded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMemory();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, embedded, closeMemory]);

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
    <div className={embedded ? "contents" : "fixed inset-y-0 right-0 left-60 z-40 flex flex-col border-l border-border bg-background"}>
      {!embedded && <div data-tauri-drag-region className="h-11 shrink-0 px-3" />}

      {/* Embedded in Settings: a fixed-height block so the note list and reader scroll inside it. */}
      <div className={embedded ? "h-[min(40rem,70vh)] border-t border-border pt-6" : "flex-1 overflow-hidden"}>
        <div className={embedded ? "flex h-full flex-col" : "mx-auto flex h-full w-full max-w-5xl flex-col px-8 pb-8 pt-2"}>
          <div className={embedded ? "mb-4 flex items-center justify-between" : "ph-page-header mx-0 mb-6 pt-0"}>
            {embedded ? <h2 className="text-[13px] font-semibold text-foreground">Notes</h2> : <h1 className="ph-page-title">Memory</h1>}
            <span className={`inline-flex items-center gap-1.5 text-xs ${healthy ? "text-muted-foreground" : "text-destructive"}`}>
              <span
                className={`ph-dot bg-current ${healthy ? "tone-running" : status === "checking" ? "animate-pulse" : ""}`}
                aria-hidden
              />
              {statusLabel[status]}
            </span>
          </div>

          <div className="mb-3 flex h-10 items-stretch justify-between gap-4 border-b border-border">
            <div className="flex gap-3">
              {projects.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setProject(p);
                    setSelected(null);
                    setConfirmDelete(false);
                  }}
                  data-active={project === p}
                  className="ph-tab px-1 text-[13px]"
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {project !== GLOBAL_PROJECT &&
                (confirmDelete ? (
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={() => void deleteProject()}
                      title={`Remove ${project} from memory. Note files stay on disk.`}
                      className="ph-btn ph-btn-danger h-7 px-2.5 text-xs"
                    >
                      {deleting ? "Deleting…" : `Delete ${project}`}
                    </button>
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={() => setConfirmDelete(false)}
                      className="ph-btn ph-btn-ghost h-7 px-2.5 text-xs"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    title={`Delete project ${project}`}
                    className="ph-btn ph-btn-ghost h-7 px-2.5 text-xs hover:!text-destructive"
                  >
                    Delete project
                  </button>
                ))}
              <div role="group" aria-label="View" className="ph-segmented h-8">
              {(["inbox", "browse"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setView(v);
                    setSelected(null);
                  }}
                  aria-pressed={view === v}
                  className="capitalize"
                >
                  {v}
                  {v === "inbox" && inbox.length > 0 ? ` (${inbox.length})` : ""}
                </button>
              ))}
              </div>
            </div>
          </div>

          {view === "browse" && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${project}… (empty = recent)`}
              className="ph-input mb-3 h-8"
            />
          )}

          {notice && <p className="ph-hint mb-2">{notice}</p>}
          {error && <p className="ph-error mb-2">{error}</p>}

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,22rem)_1fr] gap-4">
            <ul className="ph-list min-h-0 overflow-y-auto">
              {list.length === 0 && !loading && (
                <li className="ph-hint px-3 py-4">
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
                  className={selected?.permalink === n.permalink ? "bg-accent" : undefined}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(n)}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-accent"
                  >
                    <span className="text-[13px] text-foreground">{n.title}</span>
                    <span className="text-xs text-muted-foreground">
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
                        className="ph-btn h-6 px-2 text-xs"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={acting}
                        onClick={() => void discard(n)}
                        className="ph-btn ph-btn-ghost h-6 px-2 text-xs hover:!text-destructive"
                      >
                        Discard
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="ph-list min-h-0 overflow-y-auto p-4">
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
                            className="ph-btn h-6 px-2 text-xs"
                          >
                            Edit
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={acting}
                              onClick={() => void saveDraft()}
                              className="ph-btn ph-btn-primary h-6 px-2 text-xs"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setDraft(null)}
                              className="ph-btn h-6 px-2 text-xs"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="mb-3 font-mono text-xs text-muted-foreground">{selected.permalink}</p>
                  {draft == null ? (
                    <pre className="select-text whitespace-pre-wrap font-sans text-[13px] leading-6 text-foreground">{body}</pre>
                  ) : (
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      className="ph-input h-auto min-h-64 resize-y p-2.5 font-mono text-xs leading-5"
                    />
                  )}
                </>
              ) : (
                <p className="ph-hint">
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
