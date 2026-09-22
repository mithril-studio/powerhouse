import { useEffect, useState } from "react";
import {
  PROPOSAL_METRICS,
  proposalAdopt,
  proposalCreate,
  proposalDecide,
  proposalEvaluate,
  proposalList,
  type Proposal,
  type ProposalMetric,
} from "../../lib/ipc";
import { useAppStore } from "../../store/appStore";
import { fmtMetricSample, fmtWhen } from "../../lib/telemetryFormat";

function statusTone(status: Proposal["status"]): string {
  switch (status) {
    case "adopted":
      return "text-accent-brand";
    case "kept":
      return "text-success";
    case "reverted":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function verdictTone(verdict: string): string {
  switch (verdict) {
    case "improved":
      return "text-success";
    case "regressed":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function metricLabel(key: ProposalMetric): string {
  return PROPOSAL_METRICS.find((m) => m.key === key)?.label ?? key;
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const repos = useAppStore((s) => s.repos);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [target, setTarget] = useState("");
  const [metric, setMetric] = useState<ProposalMetric>("first_pass_merge_rate");
  const [repoId, setRepoId] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="pi-btn self-start text-[11px]">
        New proposal
      </button>
    );
  }

  const inputClass =
    "w-full border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-accent-brand";

  const submit = () => {
    proposalCreate({
      title,
      hypothesis,
      target,
      metric,
      repoId: repoId || undefined,
      evidenceRunIds: evidence
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter(Boolean),
    })
      .then(() => {
        setOpen(false);
        setTitle("");
        setHypothesis("");
        setTarget("");
        setEvidence("");
        setError(null);
        onCreated();
      })
      .catch((cause) => setError(String(cause)));
  };

  return (
    <div className="pi-card flex flex-col gap-2 p-3">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        New proposal
      </span>
      <input
        className={inputClass}
        placeholder="Title — what change is being tried"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className={`${inputClass} min-h-16 resize-y`}
        placeholder="Hypothesis — why this change should move the metric"
        value={hypothesis}
        onChange={(e) => setHypothesis(e.target.value)}
      />
      <input
        className={inputClass}
        placeholder="Target artifact — e.g. 'claude agent args', 'queue check step: lint'"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      />
      <div className="flex gap-2">
        <select
          className={inputClass}
          value={metric}
          onChange={(e) => setMetric(e.target.value as ProposalMetric)}
        >
          {PROPOSAL_METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label} ({m.higherIsBetter ? "higher" : "lower"} is better)
            </option>
          ))}
        </select>
        <select className={inputClass} value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          <option value="">All projects</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.name}
            </option>
          ))}
        </select>
      </div>
      <input
        className={inputClass}
        placeholder="Evidence run ids (optional, comma-separated)"
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
      />
      {error && <span className="text-[11px] text-destructive">{error}</span>}
      <div className="flex gap-2">
        <button type="button" onClick={submit} className="pi-btn pi-btn-primary text-[11px]">
          Create
        </button>
        <button type="button" onClick={() => setOpen(false)} className="pi-btn text-[11px]">
          Cancel
        </button>
      </div>
    </div>
  );
}

function ProposalCard({
  proposal,
  onChanged,
  now,
}: {
  proposal: Proposal;
  onChanged: (next: Proposal) => void;
  now: number;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const act = (action: Promise<Proposal>) => {
    action.then(onChanged).catch((cause) => setError(String(cause)));
  };

  const evaluation = proposal.evaluation;
  return (
    <div className="pi-card flex flex-col gap-1.5 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          {proposal.title}
        </span>
        <span className={`shrink-0 text-[10px] uppercase tracking-wider ${statusTone(proposal.status)}`}>
          {proposal.status}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {fmtWhen(proposal.createdAt, now)}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">{proposal.hypothesis}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>target: {proposal.target}</span>
        <span>metric: {metricLabel(proposal.metric)}</span>
        <span>min n: {proposal.minSamples}</span>
        {proposal.evidenceRunIds.length > 0 && (
          <span>evidence: {proposal.evidenceRunIds.map((id) => id.slice(0, 8)).join(", ")}</span>
        )}
      </div>

      {proposal.baseline && (
        <div className="flex flex-wrap gap-x-4 text-[11px]">
          <span className="text-muted-foreground">
            baseline {fmtMetricSample(proposal.baseline)}
          </span>
          {evaluation && (
            <>
              <span className="text-muted-foreground">
                since adoption {fmtMetricSample(evaluation.evaluation)}
              </span>
              <span className={verdictTone(evaluation.verdict)}>{evaluation.verdict}</span>
            </>
          )}
        </div>
      )}
      {proposal.decisionNote && (
        <p className="text-[11px] text-muted-foreground">note: {proposal.decisionNote}</p>
      )}
      {error && <span className="text-[11px] text-destructive">{error}</span>}

      <div className="mt-1 flex items-center gap-2">
        {proposal.status === "proposed" && (
          <>
            <button
              type="button"
              onClick={() => act(proposalAdopt(proposal.proposalId))}
              className="pi-btn pi-btn-primary text-[11px]"
              title="Freeze the baseline and start measuring from now"
            >
              Adopt
            </button>
            <button
              type="button"
              onClick={() => act(proposalDecide(proposal.proposalId, "retired"))}
              className="pi-btn text-[11px]"
            >
              Retire
            </button>
          </>
        )}
        {proposal.status === "adopted" && (
          <>
            <button
              type="button"
              onClick={() => act(proposalEvaluate(proposal.proposalId))}
              className="pi-btn pi-btn-primary text-[11px]"
              title="Deterministically compare baseline vs since-adoption"
            >
              Evaluate
            </button>
            <input
              className="w-48 border border-border bg-background px-2 py-1 text-[11px] text-foreground outline-none focus:border-accent-brand"
              placeholder="decision note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              type="button"
              onClick={() => act(proposalDecide(proposal.proposalId, "kept", note || undefined))}
              className="pi-btn text-[11px]"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={() =>
                act(proposalDecide(proposal.proposalId, "reverted", note || undefined))
              }
              className="pi-btn text-[11px]"
            >
              Revert
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function ProposalsView({ refreshKey }: { refreshKey: number }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const now = Date.now();

  const reload = () => {
    proposalList().then(setProposals).catch(() => {});
  };
  useEffect(reload, [refreshKey]);

  const replace = (next: Proposal) =>
    setProposals((prev) => prev.map((p) => (p.proposalId === next.proposalId ? next : p)));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        A proposal is a reviewable improvement hypothesis. Adopting freezes the baseline;
        evaluation compares it against everything since — deterministically, with an explicit
        insufficient-evidence verdict. Before/after movement is correlation, not proof: the
        verdict informs your keep/revert decision, it doesn't make it.
      </p>
      <CreateForm onCreated={reload} />
      {proposals.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">No proposals yet.</p>
      ) : (
        proposals.map((proposal) => (
          <ProposalCard
            key={proposal.proposalId}
            proposal={proposal}
            onChanged={replace}
            now={now}
          />
        ))
      )}
    </div>
  );
}
