import { useEffect, useMemo, useRef, useState } from "react";
import { parseUnifiedDiff, splitDiffRows, type DiffRow } from "../lib/unifiedDiff";
import { CopyButton } from "./acp/CopyButton";

function Row({ row, side }: { row: DiffRow | null; side?: "before" | "after" }) {
  const kind = row?.kind ?? "gap";
  return <div className={`diff-row diff-${kind} ${side ? "diff-half" : ""}`}>
    {!side && <span className="diff-line-number" aria-hidden="true">{row?.oldLine}</span>}
    <span className="diff-line-number" aria-hidden="true">{side === "before" ? row?.oldLine : row?.newLine}</span>
    <span className="diff-sign" aria-hidden="true">{kind === "added" ? "+" : kind === "removed" ? "−" : " "}</span>
    <code>{row?.text || " "}</code>
  </div>;
}

export function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [activeHunk, setActiveHunk] = useState(0);
  const hunks = useRef(new Map<number, HTMLElement>());
  const count = files.reduce((n, file) => n + file.hunks.length, 0);
  const added = files.reduce((n, file) => n + file.added, 0);
  const removed = files.reduce((n, file) => n + file.removed, 0);
  useEffect(() => setActiveHunk(0), [diff]);

  const jump = (direction: number) => {
    const next = Math.max(0, Math.min(count - 1, activeHunk + direction));
    const target = hunks.current.get(next);
    if (!target) return;
    const disclosure = target.closest("details");
    if (disclosure) disclosure.open = true;
    target.scrollIntoView({ block: "nearest" });
    setActiveHunk(next);
  };
  if (files.length === 0) return <p className="p-6 text-center text-xs text-muted-foreground">No changes in this file.</p>;
  let hunkIndex = 0;
  return <div className={`diff-view ${wrap ? "diff-wrap" : ""}`}>
    <div className="diff-toolbar">
      <span className="text-success" aria-label={`${added} additions`}>+{added}</span>
      <span className="text-destructive" aria-label={`${removed} deletions`}>−{removed}</span>
      <span className="flex-1" />
      <div className="diff-mode" role="group" aria-label="Diff layout">
        <button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>Unified</button>
        <button type="button" aria-pressed={split} onClick={() => setSplit(true)}>Split</button>
      </div>
      <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap</button>
      <CopyButton text={diff} label="Copy diff" />
    </div>
    {count > 1 && <div className="diff-navigation">
      <span>Change {Math.min(activeHunk + 1, count)} of {count}</span>
      <button type="button" aria-label="Previous change" disabled={activeHunk === 0} onClick={() => jump(-1)}>↑</button>
      <button type="button" aria-label="Next change" disabled={activeHunk >= count - 1} onClick={() => jump(1)}>↓</button>
    </div>}
    {files.map((file, fileIndex) => <details key={`${file.path}:${fileIndex}`} open className="diff-file">
      <summary title={file.path}><span className="min-w-0 flex-1 truncate">{file.path}</span><span className="text-success">+{file.added}</span><span className="text-destructive">−{file.removed}</span></summary>
      {file.metadata.length > 0 && <pre className="diff-metadata">{file.metadata.join("\n")}</pre>}
      {split && file.hunks.length > 0 && <div className="diff-split-labels"><span>Before</span><span>After</span></div>}
      {file.hunks.map((hunk, i) => {
        const index = hunkIndex++;
        return <section key={i} ref={(node) => { if (node) hunks.current.set(index, node); else hunks.current.delete(index); }} aria-label={`Change ${index + 1}`}>
          <div className="diff-hunk-header">{hunk.header}</div>
          <div className="diff-lines">
            {split ? <table className="diff-split-table" aria-label="Before and after changes"><tbody>{splitDiffRows(hunk.rows).map((pair, j) => <tr key={j}><td><Row row={pair.before} side="before" /></td><td><Row row={pair.after} side="after" /></td></tr>)}</tbody></table> : hunk.rows.map((row, j) => <Row key={j} row={row} />)}
          </div>
        </section>;
      })}
    </details>)}
  </div>;
}
