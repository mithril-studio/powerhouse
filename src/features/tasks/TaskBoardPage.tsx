import { CloudPane } from "../../components/CloudPane";
import { useTaskFacts } from "./useTaskFacts";
import { useEffect, useState } from "react";
import { useAppStore, type Branch } from "../../store/appStore";
import { cancelSession, useSessions } from "../../lib/agentSessionService";
import { AcpPermissionCard } from "../../components/acp/AcpPermissionCard";
import {
  deleteBranch,
  cancelQueueEntry,
  dismissEntry,
} from "../../lib/actions";
import { TASK_COLUMNS, type Task } from "./types";
import { taskPresentation } from "./taskState";
import { adoptBranch, updateTask } from "./taskStore";
import {
  acknowledgeTask,
  archiveTask,
  cancelTaskCloud,
  chooseTaskAgent,
  completeTask,
  enqueueTask,
  importTaskCloudResult,
  linkCloudTask,
  openTask,
  parkTask,
  retryTaskChecks,
  startTask,
} from "./taskActions";
import { refreshIssues, useIssueCache } from "./githubIssues";
import { TaskComposer } from "./TaskComposer";

function lastReply(branch?: Branch) {
  const chat =
    branch?.chats.find((c) => c.id === branch.activeChatId) ?? branch?.chats[0];
  const item = [...(chat?.acpTranscript ?? [])]
    .reverse()
    .find((i) => i.type === "message" && i.role === "assistant");
  return item?.type === "message"
    ? item.text.slice(-700)
    : "Open the workspace to continue this task.";
}
export function TaskBoardPage() {
  const state = useAppStore();
  const sessions = useSessions((s) => s.sessions);
  const caches = useIssueCache((s) => s.repos);
  const [scope, setScope] = useState(state.selection.repoId ?? "all");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composer, setComposer] = useState<{
    title: string;
    description: string;
    source?: Task["source"];
  } | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const mission = state.workspaceView === "mission";
  const project = state.repos.find((r) => r.id === scope);
  const issueCache = caches[scope];
  const facts = useTaskFacts(
    state.tasks.filter((t) => scope === "all" || t.repoId === scope),
    state.repos,
  );
  // Refresh only a selected project's intake, never all connected repositories.
  useEffect(() => {
    if (!project) return;
    const refresh = () => {
      if (!document.hidden) void refreshIssues(project.id, project.path);
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [project?.id, project?.path]);
  async function run(key: string, action: () => unknown | Promise<unknown>) {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(null);
    }
  }
  function row(task: Task) {
    const repo = state.repos.find((r) => r.id === task.repoId);
    const branch = repo?.branches.find((b) => b.id === task.branchId);
    const cloud = task.cloudRunId
      ? state.cloudRuns[task.cloudRunId]
      : undefined;
    return {
      task,
      repo,
      branch,
      cloud,
      status: taskPresentation(
        task,
        branch,
        sessions,
        state.queues[task.repoId] ?? [],
        cloud,
        facts[task.id],
      ),
    };
  }
  const tasks = state.tasks
    .filter(
      (t) =>
        (scope === "all" || t.repoId === scope) &&
        Boolean(t.archivedAt) === archived &&
        `${t.title} ${t.description} ${state.repos.find((r) => r.id === t.repoId)?.name}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id),
    )
    .map(row);
  const selectedTask = state.tasks.find((t) => t.id === selectedId);
  const selected = selectedTask ? row(selectedTask) : null;
  const issues = (issueCache?.issues ?? []).filter(
    (i) =>
      !state.tasks.some(
        (t) =>
          t.repoId === scope &&
          t.source?.number === i.number &&
          t.source.repository.toLowerCase() ===
            issueCache.repository.toLowerCase() &&
          !t.archivedAt,
      ) && `${i.title} ${i.number}`.toLowerCase().includes(query.toLowerCase()),
  );
  const unlinkedRuns = Object.values(state.cloudRuns).filter(
    (r) =>
      (scope === "all" || r.repo_id === scope) &&
      !state.tasks.some((t) => t.cloudRunId === r.run_id) &&
      state.repos.some((p) => p.id === r.repo_id),
  );
  const unlinkedBranches = state.repos
    .filter((r) => scope === "all" || r.id === scope)
    .flatMap((repo) =>
      repo.branches
        .filter((b) => !state.tasks.some((t) => t.branchId === b.id))
        .map((branch) => ({ repo, branch })),
    );
  function select(id: string) {
    setSelectedId(id);
    updateTask(id, { seenAt: Date.now() });
  }
  const card = (item: ReturnType<typeof row>) => (
    <article
      key={item.task.id}
      className={`task-card ${selectedId === item.task.id ? "task-card-selected" : ""}`}
    >
      <button
        className="w-full text-left"
        onClick={() => select(item.task.id)}
        aria-label={`Open task: ${item.task.title}`}
      >
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {item.repo?.name ?? "Missing project"} ·{" "}
            {state.settings.agents.find((a) => a.id === item.task.agentId)
              ?.name ?? item.task.agentId}
          </span>
          {item.task.lastActivityAt > item.task.seenAt && (
            <span
              aria-label="Unread activity"
              className="size-2 rounded-full bg-primary"
            />
          )}
        </div>
        <h3 className="break-words text-sm font-medium">{item.task.title}</h3>
        <p
          className={`mt-2 text-xs ${item.status.column === "attention" ? "text-amber-500" : "text-muted-foreground"}`}
        >
          {item.status.reason}
        </p>
        {facts[item.task.id] && (
          <p className="mt-2 text-xs text-muted-foreground">
            {facts[item.task.id].changed_files} changed files
            {facts[item.task.id].dirty ? " · uncommitted changes" : ""}
          </p>
        )}
        {item.task.source && (
          <p className="mt-2 text-xs text-muted-foreground">
            Issue #{item.task.source.number}
          </p>
        )}
        {item.cloud && (
          <p className="mt-2 text-xs text-muted-foreground">
            Cloud ·{" "}
            {item.cloud.last_sync_ms
              ? `synced ${new Date(item.cloud.last_sync_ms).toLocaleTimeString()}`
              : "awaiting sync"}
          </p>
        )}
        {mission && (
          <p className="mt-4 max-h-32 overflow-hidden whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
            {lastReply(item.branch)}
          </p>
        )}
      </button>
      {(item.branch?.chats ?? []).flatMap((chat) =>
        (sessions[chat.id]?.permissions ?? []).map((p) => (
          <AcpPermissionCard
            key={p.id}
            permission={p}
            onResolve={p.resolve}
            autoFocus={false}
          />
        )),
      )}
    </article>
  );
  return (
    <>
      <section
        aria-label={mission ? "Mission Control" : "Task board"}
        className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
        inert={showComposer}
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
          <div className="mr-auto">
            <h1 className="text-lg font-semibold tracking-tight">
              {mission ? "Mission Control" : "Task board"}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {tasks.length} tasks ·{" "}
              {tasks.filter((t) => t.status.column === "attention").length} need
              you
            </p>
          </div>
          <select
            aria-label="Task project"
            style={{ width: "auto" }}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setSelectedId(null);
            }}
            className="task-input w-auto"
          >
            <option value="all">All projects</option>
            {state.repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <input
            aria-label="Search tasks"
            style={{ width: "12rem" }}
            placeholder="Search tasks…"
            className="task-input w-48"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="pi-btn"
            aria-pressed={archived}
            onClick={() => setArchived(!archived)}
          >
            {archived ? "Show active" : "Archived"}
          </button>
          <button
            className="pi-btn pi-btn-primary"
            disabled={!state.repos.length}
            onClick={() => {
              setComposer(null);
              setShowComposer(true);
            }}
          >
            + New task
          </button>
        </header>
        {error && (
          <div
            role="alert"
            className="flex items-center gap-3 border-b border-destructive/30 px-6 py-3 text-sm text-destructive"
          >
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {(unlinkedBranches.length > 0 || unlinkedRuns.length > 0) && (
          <details className="border-b border-border px-6 py-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              Add existing work · {unlinkedBranches.length} branches ·{" "}
              {unlinkedRuns.length} cloud runs
            </summary>
            <div className="mt-3 flex flex-wrap gap-2">
              {unlinkedBranches.length > 1 && (
                <button
                  className="pi-btn"
                  onClick={() =>
                    unlinkedBranches.forEach(({ repo, branch }) =>
                      adoptBranch(repo.id, branch.id),
                    )
                  }
                >
                  Attach all branches
                </button>
              )}
              {unlinkedBranches.map(({ repo, branch }) => (
                <button
                  className="pi-btn"
                  key={branch.id}
                  onClick={() => {
                    const t = adoptBranch(repo.id, branch.id);
                    select(t.id);
                  }}
                >
                  Attach {repo.name} / {branch.name}
                </button>
              ))}
              {unlinkedRuns.map((r) => (
                <button
                  className="pi-btn"
                  key={r.run_id}
                  onClick={() =>
                    void run(r.run_id, () => {
                      const t = linkCloudTask(r);
                      select(t.id);
                    })
                  }
                >
                  Link cloud: {r.manifest.task.text.slice(0, 60)}
                </button>
              ))}
            </div>
          </details>
        )}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {mission ? (
            <div className="grid min-w-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-4 overflow-auto p-5">
              {[...tasks]
                .sort(
                  (a, b) =>
                    Number(b.status.column === "attention") -
                    Number(a.status.column === "attention"),
                )
                .map(card)}
              {!tasks.length && (
                <p className="p-6 text-sm text-muted-foreground">
                  No tasks in this view. Create a task or attach existing work.
                </p>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 gap-4 overflow-x-auto p-5">
              {TASK_COLUMNS.map((column) => {
                const items = tasks.filter(
                  (t) => t.status.column === column.id,
                );
                return (
                  <section
                    key={column.id}
                    aria-label={column.label}
                    className="flex w-64 min-w-60 flex-1 flex-col"
                  >
                    <h2 className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {column.label}
                      <span className="rounded bg-muted px-1.5 py-0.5">
                        {items.length +
                          (column.id === "backlog" && !archived
                            ? issues.length
                            : 0)}
                      </span>
                    </h2>
                    <div className="min-h-0 space-y-3 overflow-y-auto pb-4">
                      {items.map(card)}
                      {column.id === "backlog" && !archived && (
                        <>
                          {project ? (
                            <div className="text-xs text-muted-foreground">
                              <div className="mb-2 flex items-center justify-between">
                                <span>GitHub issues</span>
                                <button
                                  disabled={issueCache?.loading}
                                  className="pi-btn"
                                  onClick={() =>
                                    void refreshIssues(project.id, project.path)
                                  }
                                >
                                  {issueCache?.loading ? "Syncing…" : "Refresh"}
                                </button>
                              </div>
                              {issueCache?.error && (
                                <p
                                  role="status"
                                  className="mb-2 text-amber-500"
                                >
                                  {issueCache.error}
                                  {issueCache.at
                                    ? ` Cached ${new Date(issueCache.at).toLocaleString()}.`
                                    : ""}
                                </p>
                              )}
                              {!issueCache?.error && issueCache?.at ? (
                                <p className="mb-2">
                                  Synced{" "}
                                  {new Date(issueCache.at).toLocaleTimeString()}
                                </p>
                              ) : null}
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Choose a project to browse its GitHub issues.
                            </p>
                          )}
                          {issues.map((issue) => (
                            <button
                              key={issue.number}
                              className="task-card w-full text-left"
                              onClick={() => {
                                setComposer({
                                  title: issue.title,
                                  description: issue.body,
                                  source: {
                                    repository: issueCache.repository,
                                    number: issue.number,
                                    url: issue.url,
                                  },
                                });
                                setShowComposer(true);
                              }}
                            >
                              <span className="text-xs text-muted-foreground">
                                #{issue.number} · GitHub
                              </span>
                              <p className="mt-2 text-sm">{issue.title}</p>
                              <div className="mt-2 flex flex-wrap gap-1">
                                {issue.labels.map((l) => (
                                  <span
                                    className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                                    key={l}
                                  >
                                    {l}
                                  </span>
                                ))}
                              </div>
                            </button>
                          ))}
                          {project && issueCache?.next_page && (
                            <button
                              className="pi-btn"
                              disabled={issueCache.loading}
                              onClick={() =>
                                void refreshIssues(
                                  project.id,
                                  project.path,
                                  true,
                                )
                              }
                            >
                              Load more issues
                            </button>
                          )}
                        </>
                      )}
                      {!items.length && column.id !== "backlog" && (
                        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                          No tasks
                        </p>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
          {selected && (
            <aside
              aria-label="Task details"
              className="w-80 shrink-0 overflow-y-auto border-l border-border bg-card p-5"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {selected.repo?.name}
                </span>
                <button
                  className="pi-btn"
                  aria-label="Close task details"
                  onClick={() => setSelectedId(null)}
                >
                  ×
                </button>
              </div>
              <input
                key={`${selected.task.id}-title`}
                aria-label="Task title"
                defaultValue={selected.task.title}
                className="my-3 w-full bg-transparent text-lg font-semibold outline-none focus:ring-1 focus:ring-ring"
                onBlur={(e) => {
                  if (e.target.value.trim())
                    updateTask(selected.task.id, {
                      title: e.target.value.trim(),
                    });
                }}
              />
              <p className="mb-4 text-sm text-muted-foreground">
                {selected.status.reason}
              </p>
              <textarea
                key={`${selected.task.id}-description`}
                aria-label="Task description"
                defaultValue={selected.task.description}
                className="task-input min-h-28"
                onBlur={(e) =>
                  updateTask(selected.task.id, { description: e.target.value })
                }
              />
              {selected.branch && (
                <p className="my-3 break-all text-xs text-muted-foreground">
                  {selected.branch.name}
                </p>
              )}
              <label className="task-label">
                Agent for next conversation
                <select
                  className="task-input"
                  value={selected.task.agentId}
                  disabled={!!pending || selected.status.column === "running"}
                  onChange={(e) =>
                    void run(selected.task.id, () =>
                      chooseTaskAgent(selected.task.id, e.target.value),
                    )
                  }
                >
                  {state.settings.agents
                    .filter((a) => a.acpCommand)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="mt-4 flex flex-wrap gap-2">
                {selected.branch && (
                  <button
                    className="pi-btn pi-btn-primary"
                    onClick={() => openTask(selected.task.id)}
                  >
                    Open workspace
                  </button>
                )}
                {(!selected.task.cloudRunId || selected.branch) && (
                  <button
                    className="pi-btn"
                    disabled={!!pending || selected.status.column === "running"}
                    onClick={() =>
                      void run(selected.task.id, () =>
                        selected.task.primaryChatId &&
                        sessions[selected.task.primaryChatId]?.connection ===
                          "ready"
                          ? openTask(selected.task.id)
                          : startTask(selected.task.id),
                      )
                    }
                  >
                    {selected.task.primaryChatId &&
                    sessions[selected.task.primaryChatId]?.connection ===
                      "ready"
                      ? "Continue in chat"
                      : selected.task.primaryChatId
                        ? "Resume agent"
                        : "Start task"}
                  </button>
                )}
                {(selected.branch?.chats ?? [])
                  .filter((c) => sessions[c.id]?.busy)
                  .map((c) => (
                    <button
                      key={c.id}
                      className="pi-btn"
                      disabled={sessions[c.id]?.canceling}
                      onClick={() => cancelSession(c.id)}
                    >
                      Stop {c.title}
                    </button>
                  ))}
                {selected.branch && (
                  <button
                    className="pi-btn"
                    onClick={() => {
                      openTask(selected.task.id);
                      useAppStore.getState().openRightTab("changes");
                    }}
                  >
                    Review changes
                  </button>
                )}
                {selected.branch && (
                  <button
                    className="pi-btn"
                    disabled={
                      !!pending ||
                      selected.status.column === "running" ||
                      selected.status.column === "attention"
                    }
                    onClick={() =>
                      void run(selected.task.id, () =>
                        enqueueTask(selected.task.id),
                      )
                    }
                  >
                    Run checks & merge
                    {selected.repo?.pushOnMerge ? " + push" : ""}
                  </button>
                )}
                {(state.queues[selected.task.repoId] ?? [])
                  .filter(
                    (q) =>
                      q.branch === selected.branch?.name &&
                      [
                        "queued",
                        "validating",
                        "merging",
                        "failed",
                        "interrupted",
                      ].includes(q.state),
                  )
                  .slice(0, 1)
                  .map((q) => (
                    <button
                      className="pi-btn"
                      key={q.id}
                      disabled={
                        !!pending ||
                        Boolean(
                          selected.branch?.chats.some(
                            (c) =>
                              sessions[c.id]?.busy ||
                              sessions[c.id]?.permissionCount,
                          ),
                        )
                      }
                      onClick={() =>
                        void run(q.id, () =>
                          ["failed", "interrupted"].includes(q.state)
                            ? retryTaskChecks(selected.task.id, q.id)
                            : cancelQueueEntry(selected.task.repoId, q),
                        )
                      }
                    >
                      {["failed", "interrupted"].includes(q.state)
                        ? "Retry checks"
                        : "Cancel checks"}
                    </button>
                  ))}
                {(state.queues[selected.task.repoId] ?? [])
                  .filter(
                    (q) =>
                      q.branch === selected.branch?.name &&
                      ["failed", "interrupted"].includes(q.state),
                  )
                  .slice(0, 1)
                  .map((q) => (
                    <button
                      className="pi-btn"
                      key={`dismiss-${q.id}`}
                      disabled={!!pending}
                      onClick={() =>
                        void run(q.id, () =>
                          dismissEntry(selected.task.repoId, q.id),
                        )
                      }
                    >
                      Dismiss failed checks
                    </button>
                  ))}
                {selected.cloud && (
                  <>
                    <button
                      className="pi-btn"
                      disabled={
                        !!pending ||
                        selected.cloud.snapshot?.state !== "completed"
                      }
                      onClick={() =>
                        void run(selected.task.id, () =>
                          importTaskCloudResult(selected.task.id),
                        )
                      }
                    >
                      Import cloud result
                    </button>
                    <button
                      className="pi-btn"
                      disabled={
                        !!pending || selected.status.column !== "running"
                      }
                      onClick={() =>
                        void run(selected.task.id, () =>
                          cancelTaskCloud(selected.task.id),
                        )
                      }
                    >
                      Cancel cloud run
                    </button>
                  </>
                )}
                {selected.status.column === "attention" &&
                  !selected.task.cloudRunId && (
                    <button
                      className="pi-btn"
                      disabled={!!pending}
                      onClick={() =>
                        void run(selected.task.id, () =>
                          acknowledgeTask(selected.task.id),
                        )
                      }
                    >
                      Acknowledge interruption
                    </button>
                  )}
                <button
                  className="pi-btn"
                  disabled={
                    !!pending ||
                    ["running", "attention", "done"].includes(
                      selected.status.column,
                    )
                  }
                  onClick={() =>
                    void run(selected.task.id, () =>
                      completeTask(selected.task.id),
                    )
                  }
                >
                  Complete non-code task
                </button>
                <button
                  className="pi-btn"
                  disabled={
                    !!pending ||
                    ["running", "attention", "backlog"].includes(
                      selected.status.column,
                    )
                  }
                  onClick={() =>
                    void run(selected.task.id, () => parkTask(selected.task.id))
                  }
                >
                  Return to backlog
                </button>
                <button
                  className="pi-btn"
                  disabled={!!pending}
                  onClick={() =>
                    void run(selected.task.id, () =>
                      archiveTask(selected.task.id, !selected.task.archivedAt),
                    )
                  }
                >
                  {selected.task.archivedAt ? "Restore" : "Archive"}
                </button>
                {selected.branch && selected.task.archivedAt && (
                  <button
                    className="pi-btn text-destructive"
                    disabled={!!pending}
                    onClick={() =>
                      void run(selected.task.id, () =>
                        deleteBranch(selected.task.repoId, selected.branch!.id),
                      )
                    }
                  >
                    Remove worktree…
                  </button>
                )}
              </div>
              {selected.cloud && selected.repo && (
                <details className="mt-5">
                  <summary className="cursor-pointer text-sm">
                    Cloud run details and logs
                  </summary>
                  <CloudPane repo={selected.repo} branch={selected.branch} />
                </details>
              )}
              <p className="mt-5 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                {lastReply(selected.branch)}
              </p>
              {selected.branch?.chats.map((c) => (
                <div className="mt-4" key={c.id}>
                  <p className="text-xs font-medium">{c.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {sessions[c.id]
                      ? sessions[c.id].busy
                        ? "Working"
                        : sessions[c.id].connection
                      : "Not connected"}
                  </p>
                </div>
              ))}
            </aside>
          )}
        </div>
      </section>
      {showComposer && (
        <TaskComposer
          repoId={scope === "all" ? (state.repos[0]?.id ?? "") : scope}
          seed={composer ?? undefined}
          onClose={() => setShowComposer(false)}
          onCreated={select}
          onError={setError}
        />
      )}
    </>
  );
}
