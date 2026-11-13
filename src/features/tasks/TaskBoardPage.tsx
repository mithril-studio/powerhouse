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
import { TASK_COLUMNS, type Task, type TaskColumn, type TaskFacts } from "./types";
import { taskPresentation } from "./taskState";
import { adoptBranch, updateTask } from "./taskStore";
import {
  acknowledgeTask,
  archiveTask,
  chooseTaskAgent,
  completeTask,
  enqueueTask,
  openTask,
  parkTask,
  retryTaskChecks,
  startTask,
} from "./taskActions";
import { refreshIssues, useIssueCache } from "./githubIssues";
import { TaskComposer } from "./TaskComposer";
import {
  Menu,
  PageHeader,
  Segmented,
  SelectControl,
  SplitButton,
  type MenuItem,
} from "../../components/ui/page";
import { CloseIcon, MoreIcon, PlusIcon, RefreshIcon, WarningIcon } from "../../components/ui/icons";

/** What an empty column tells you — what will land there, not that it's empty. */
const EMPTY_COPY: Record<TaskColumn, string> = {
  backlog: "Nothing queued up.",
  running: "Start a task and its agent works here.",
  attention: "Agents will ask here when they're blocked.",
  review: "Finished work lands here for review.",
  done: "Nothing merged yet.",
};

/** Mission Control shows live work only, most urgent first. */
const MISSION_GROUPS: { id: TaskColumn; label: string }[] = [
  { id: "attention", label: "Needs you" },
  { id: "running", label: "Working" },
  { id: "review", label: "Ready for review" },
];

function lastReply(branch?: Branch) {
  const chat =
    branch?.chats.find((c) => c.id === branch.activeChatId) ?? branch?.chats[0];
  const item = [...(chat?.acpTranscript ?? [])]
    .reverse()
    .find((i) => i.type === "message" && i.role === "assistant");
  return item?.type === "message" ? item.text.slice(-700) : null;
}

function changesLabel(facts?: TaskFacts) {
  if (!facts) return null;
  if (facts.changed_files === 0) return facts.dirty ? "Uncommitted changes" : "No changes yet";
  return `${facts.changed_files} file${facts.changed_files === 1 ? "" : "s"} changed${facts.dirty ? " · uncommitted" : ""}`;
}

export function TaskBoardPage() {
  const state = useAppStore((s) => s);
  const sessions = useSessions((s) => s.sessions);
  const caches = useIssueCache((s) => s.repos);
  const [scope, setScope] = useState(state.selection.repoId ?? "all");
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
  function agentName(task: Task) {
    return state.settings.agents.find((a) => a.id === task.agentId)?.name ?? task.agentId;
  }
  function row(task: Task) {
    const repo = state.repos.find((r) => r.id === task.repoId);
    const branch = repo?.branches.find((b) => b.id === task.branchId);
    return {
      task,
      repo,
      branch,
      status: taskPresentation(
        task,
        branch,
        sessions,
        state.queues[task.repoId] ?? [],
        facts[task.id],
      ),
    };
  }
  type Row = ReturnType<typeof row>;
  const tasks = state.tasks
    .filter(
      (t) =>
        (scope === "all" || t.repoId === scope) &&
        Boolean(t.archivedAt) === (archived && !mission),
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
      ),
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
  function newTask(seed: typeof composer = null) {
    setComposer(seed);
    setShowComposer(true);
  }

  // Attaching existing work is a way of creating a task, so it lives in the
  // New task menu instead of a strip above the board.
  const attachItems: (MenuItem | "separator")[] = [
    ...(unlinkedBranches.length > 1
      ? [{
          label: `Attach all ${unlinkedBranches.length} branches`,
          onSelect: () => unlinkedBranches.forEach(({ repo, branch }) => adoptBranch(repo.id, branch.id)),
        }]
      : []),
    ...unlinkedBranches.map(({ repo, branch }) => ({
      label: `Attach ${scope === "all" ? `${repo.name} / ` : ""}${branch.name}`,
      onSelect: () => select(adoptBranch(repo.id, branch.id).id),
    })),
  ];

  const card = (item: Row) => {
    const column = item.status.column;
    const agent = agentName(item.task);
    const meta = [
      scope === "all" ? (item.repo?.name ?? "Missing project") : null,
      item.branch?.name ?? item.task.launch.branchName,
      item.task.source ? `#${item.task.source.number}` : null,
    ].filter(Boolean).join(" · ");
    const statusLabel =
      column === "running" && item.status.reason === "Agent working"
        ? `${agent} working`
        : item.status.reason;
    const changes = column === "done" ? null : changesLabel(facts[item.task.id]);
    const reply = mission ? lastReply(item.branch) : null;
    const permissions = (item.branch?.chats ?? []).flatMap((chat) => sessions[chat.id]?.permissions ?? []);
    return (
      <article key={item.task.id} className="ph-card" data-selected={selectedId === item.task.id}>
        <button onClick={() => select(item.task.id)} aria-label={`Open task: ${item.task.title}`}>
          {item.task.lastActivityAt > item.task.seenAt && (
            <span aria-label="Unread activity" className="ph-card-unread" />
          )}
          <h3 className="ph-card-title">{item.task.title}</h3>
          {meta && <p className="ph-card-meta">{meta}</p>}
          {reply && <p className="ph-card-reply">{reply}</p>}
          {column === "backlog" ? (
            <div className="ph-card-foot">
              <span><span>{agent}</span></span>
              <span>{item.status.reason}</span>
            </div>
          ) : (
            <div className="ph-card-foot">
              <span className={`tone-${column}`} title={statusLabel}>
                <span aria-hidden className="ph-dot bg-current" />
                <span>{statusLabel}</span>
              </span>
              {changes && <span>{changes}</span>}
            </div>
          )}
        </button>
        {permissions.map((p) => (
          <AcpPermissionCard key={p.id} permission={p} onResolve={p.resolve} autoFocus={false} />
        ))}
      </article>
    );
  };

  const issueNotice = project && issueCache?.error && (
    <div role="status" className="ph-notice" title={issueCache.error}>
      <WarningIcon className="size-3.5" />
      <span>
        GitHub offline
        {issueCache.at ? " · showing cached issues" : ""}
      </span>
      <button
        aria-label="Retry GitHub sync"
        disabled={issueCache.loading}
        onClick={() => void refreshIssues(project.id, project.path)}
      >
        <RefreshIcon className="size-3.5" />
      </button>
    </div>
  );

  const backlogExtras = !archived && (
    <>
      <button className="ph-add" disabled={!state.repos.length} onClick={() => newTask()}>
        <PlusIcon className="size-3.5" />
        Add task
      </button>
      {issueNotice}
      {issues.map((issue) => (
        <article key={issue.number} className="ph-card">
          <button
            onClick={() =>
              newTask({
                title: issue.title,
                description: issue.body,
                source: { repository: issueCache.repository, number: issue.number, url: issue.url },
              })
            }
          >
            <h3 className="ph-card-title">{issue.title}</h3>
            <p className="ph-card-meta">#{issue.number}</p>
            <div className="ph-card-foot">
              <span><span>GitHub issue</span></span>
              {issue.labels.length > 0 && <span className="truncate">{issue.labels.slice(0, 2).join(", ")}</span>}
            </div>
          </button>
        </article>
      ))}
      {project && issueCache?.next_page && (
        <button
          className="ph-text-btn"
          disabled={issueCache.loading}
          onClick={() => void refreshIssues(project.id, project.path, true)}
        >
          {issueCache.loading ? "Loading…" : "Load more issues"}
        </button>
      )}
    </>
  );

  const live = MISSION_GROUPS.map((g) => ({
    ...g,
    items: tasks.filter((t) => t.status.column === g.id),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <section
        aria-label={mission ? "Mission Control" : "Task board"}
        className="ph-page"
        inert={showComposer}
      >
        <PageHeader title={mission ? "Mission Control" : "Task board"}>
          <SelectControl
            label="Task project"
            value={scope}
            onChange={(v) => {
              setScope(v);
              setSelectedId(null);
            }}
            options={[
              { value: "all", label: "All projects" },
              ...state.repos.map((r) => ({ value: r.id, label: r.name })),
            ]}
          />
          {!mission && (
            <Segmented
              label="Task visibility"
              value={archived ? "archived" : "active"}
              onChange={(v) => {
                setArchived(v === "archived");
                setSelectedId(null);
              }}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
              ]}
            />
          )}
          <SplitButton
            label="New task"
            disabled={!state.repos.length}
            onClick={() => newTask()}
            menuLabel="More ways to add a task"
            items={
              attachItems.length
                ? attachItems
                : [{ label: "No branches to attach", disabled: true, onSelect: () => {} }]
            }
          />
        </PageHeader>
        {error && (
          <div role="alert" className="mx-8 mt-4 flex items-center gap-3 rounded-lg bg-destructive/10 px-4 py-2.5 text-[13px] text-destructive">
            <span className="flex-1">{error}</span>
            <button className="ph-icon-btn text-destructive" onClick={() => setError(null)} aria-label="Dismiss error">
              <CloseIcon className="size-3.5" />
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {mission ? (
            <div className="ph-mission">
              {live.map((group) => (
                <section key={group.id} aria-label={group.label}>
                  <h2 className="ph-column-head">
                    {group.label}
                    <span>{group.items.length}</span>
                  </h2>
                  <div className="ph-mission-grid">{group.items.map(card)}</div>
                </section>
              ))}
              {!live.length && (
                <div className="ph-empty">
                  <h2>No agents running</h2>
                  <p>Start a task and you can watch it here, live.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="ph-board">
              {TASK_COLUMNS.map((column) => {
                const items = tasks.filter((t) => t.status.column === column.id);
                const count = items.length + (column.id === "backlog" && !archived ? issues.length : 0);
                return (
                  <section key={column.id} aria-label={column.label} className="ph-column">
                    <h2 className="ph-column-head">
                      {column.label}
                      <span>{count}</span>
                    </h2>
                    <div className="ph-column-body">
                      {items.map(card)}
                      {column.id === "backlog" && backlogExtras}
                      {!items.length && (column.id !== "backlog" || archived) && (
                        <p className="ph-column-empty">
                          {archived ? "Nothing archived." : EMPTY_COPY[column.id]}
                        </p>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
          {selected && (
            <TaskDetail
              item={selected}
              agent={agentName(selected.task)}
              facts={facts[selected.task.id]}
              pending={pending}
              run={run}
              onClose={() => setSelectedId(null)}
            />
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

type DetailRow = {
  task: Task;
  repo?: ReturnType<typeof useAppStore.getState>["repos"][number];
  branch?: Branch;
  status: { column: TaskColumn; reason: string };
};

/**
 * Task inspector: identity, state, properties, then actions. One primary
 * action for the task's current state; rare or destructive actions live in ⋯.
 */
function TaskDetail({
  item,
  agent,
  facts,
  pending,
  run,
  onClose,
}: {
  item: DetailRow;
  agent: string;
  facts?: TaskFacts;
  pending: string | null;
  run: (key: string, action: () => unknown | Promise<unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const state = useAppStore((s) => s);
  const sessions = useSessions((s) => s.sessions);
  const { task, branch, repo, status } = item;
  const column = status.column;
  const busy = !!pending;
  const ready = !!task.primaryChatId && sessions[task.primaryChatId]?.connection === "ready";
  const queue = (state.queues[task.repoId] ?? []).filter((q) => q.branch === branch?.name);
  const activeQueue = queue.find((q) => ["queued", "validating", "merging", "failed", "interrupted"].includes(q.state));
  const failedQueue = queue.find((q) => ["failed", "interrupted"].includes(q.state));
  const chatsBusy = Boolean(branch?.chats.some((c) => sessions[c.id]?.busy || sessions[c.id]?.permissionCount));
  const reply = lastReply(branch);

  const primary =
    branch && ready
      ? { label: "Open workspace", onClick: () => openTask(task.id), disabled: false }
      : {
          label: task.primaryChatId ? "Resume agent" : "Start task",
          onClick: () => void run(task.id, () => startTask(task.id)),
          disabled: busy || column === "running",
        };

  const moreItems: (MenuItem | "separator")[] = [
    {
      label: "Complete non-code task",
      disabled: busy || ["running", "attention", "done"].includes(column),
      onSelect: () => void run(task.id, () => completeTask(task.id)),
    },
    {
      label: "Return to backlog",
      disabled: busy || ["running", "attention", "backlog"].includes(column),
      onSelect: () => void run(task.id, () => parkTask(task.id)),
    },
    ...(failedQueue
      ? [{
          label: "Dismiss failed checks",
          disabled: busy,
          onSelect: () => void run(failedQueue.id, () => dismissEntry(task.repoId, failedQueue.id)),
        }]
      : []),
    "separator",
    {
      label: task.archivedAt ? "Restore" : "Archive",
      disabled: busy,
      onSelect: () => void run(task.id, () => archiveTask(task.id, !task.archivedAt)),
    },
    ...(branch && task.archivedAt
      ? [{
          label: "Remove worktree…",
          destructive: true,
          disabled: busy,
          onSelect: () => void run(task.id, () => deleteBranch(task.repoId, branch.id)),
        }]
      : []),
  ];

  return (
    <aside aria-label="Task details" className="ph-detail">
      <div className="flex items-center gap-1">
        <span className="mr-auto truncate font-mono text-xs text-muted-foreground">{repo?.name}</span>
        <Menu label="More task actions" items={moreItems} triggerClassName="ph-icon-btn" trigger={<MoreIcon />} />
        <button className="ph-icon-btn" aria-label="Close task details" onClick={onClose}>
          <CloseIcon className="size-3.5" />
        </button>
      </div>
      <input
        key={`${task.id}-title`}
        aria-label="Task title"
        defaultValue={task.title}
        className="mt-3 w-full rounded-sm bg-transparent text-[18px] font-semibold tracking-tight outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onBlur={(e) => {
          if (e.target.value.trim()) updateTask(task.id, { title: e.target.value.trim() });
        }}
      />
      <p className={`mt-1.5 flex items-center gap-2 text-[13px] tone-${column}`}>
        <span aria-hidden className="ph-dot bg-current" />
        <span className="min-w-0 break-words">
          {column === "running" && status.reason === "Agent working" ? `${agent} working` : status.reason}
        </span>
      </p>

      <dl className="ph-props mt-5">
        {branch && (<><dt>Branch</dt><dd className="font-mono text-xs leading-5" title={branch.name}>{branch.name}</dd></>)}
        <dt>Agent</dt>
        <dd>
          <select
            aria-label="Agent for next conversation"
            className="-ml-1 max-w-full rounded-sm bg-transparent px-1 hover:bg-accent disabled:opacity-60"
            value={task.agentId}
            disabled={busy || column === "running"}
            onChange={(e) => void run(task.id, () => chooseTaskAgent(task.id, e.target.value))}
          >
            {state.settings.agents
              .filter((a) => a.acpCommand)
              .map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
          </select>
        </dd>
        {facts && (<><dt>Changes</dt><dd>{changesLabel(facts)}</dd></>)}
        {task.source && (<><dt>Issue</dt><dd className="font-mono text-xs leading-5">#{task.source.number}</dd></>)}
      </dl>

      <textarea
        key={`${task.id}-description`}
        aria-label="Task description"
        placeholder="Add a description…"
        defaultValue={task.description}
        className="task-input mt-5 min-h-28 resize-y"
        onBlur={(e) => updateTask(task.id, { description: e.target.value })}
      />

      <div className="mt-4 flex flex-wrap gap-2">
        {primary && (
          <button className="ph-btn ph-btn-primary" disabled={primary.disabled} onClick={primary.onClick}>
            {primary.label}
          </button>
        )}
        {branch && primary?.label !== "Open workspace" && (
          <button className="ph-btn" onClick={() => openTask(task.id)}>Open workspace</button>
        )}
        {(branch?.chats ?? [])
          .filter((c) => sessions[c.id]?.busy)
          .map((c) => (
            <button key={c.id} className="ph-btn" disabled={sessions[c.id]?.canceling} onClick={() => cancelSession(c.id)}>
              Stop {c.title}
            </button>
          ))}
        {branch && (
          <button
            className="ph-btn"
            onClick={() => {
              openTask(task.id);
              useAppStore.getState().openRightTab("changes");
            }}
          >
            Review changes
          </button>
        )}
        {/* Merging only makes sense once the agent has stopped and nothing is blocked. */}
        {branch && !activeQueue && column !== "running" && column !== "attention" && (
          <button
            className="ph-btn"
            disabled={busy}
            onClick={() => void run(task.id, () => enqueueTask(task.id))}
          >
            Run checks & merge{repo?.pushOnMerge ? " + push" : ""}
          </button>
        )}
        {activeQueue && (
          <button
            className="ph-btn"
            disabled={busy || chatsBusy}
            onClick={() =>
              void run(activeQueue.id, () =>
                ["failed", "interrupted"].includes(activeQueue.state)
                  ? retryTaskChecks(task.id, activeQueue.id)
                  : cancelQueueEntry(task.repoId, activeQueue),
              )
            }
          >
            {["failed", "interrupted"].includes(activeQueue.state) ? "Retry checks" : "Cancel checks"}
          </button>
        )}
        {column === "attention" && (
          <button className="ph-btn" disabled={busy} onClick={() => void run(task.id, () => acknowledgeTask(task.id))}>
            Acknowledge interruption
          </button>
        )}
      </div>

      {reply && (
        <section className="mt-7">
          <h3 className="ph-section-label">Latest reply</h3>
          <p className="mt-2 select-text whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{reply}</p>
        </section>
      )}
      {(branch?.chats.length ?? 0) > 0 && (
        <section className="mt-7">
          <h3 className="ph-section-label">Chats</h3>
          <ul className="mt-2 space-y-1.5 text-[13px]">
            {branch!.chats.map((c) => {
              const s = sessions[c.id];
              return (
                <li key={c.id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{c.title}</span>
                  <span className={`shrink-0 text-xs ${s?.busy ? "tone-running" : "text-muted-foreground"}`}>
                    {s ? (s.busy ? "Working" : s.connection) : "Not connected"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </aside>
  );
}
