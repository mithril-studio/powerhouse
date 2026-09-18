// Hand-rolled unified-diff renderer (no syntax highlighting, v1).
function DiffLine({ line }: { line: string }) {
  let cls = "text-muted-foreground/90";
  if (line.startsWith("@@")) cls = "text-muted-foreground";
  else if (line.startsWith("+++") || line.startsWith("---")) cls = "text-muted-foreground/70";
  else if (line.startsWith("+")) cls = "text-success bg-success/10";
  else if (line.startsWith("-")) cls = "text-destructive bg-destructive/10";
  return <div className={`whitespace-pre px-3 ${cls}`}>{line || " "}</div>;
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <div className="select-text font-mono text-xs leading-relaxed">
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
    </div>
  );
}
