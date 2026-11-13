export function AcpFooter({
  agentName,
  branchName,
  busy,
  nativeCliOpen,
}: {
  agentName: string;
  branchName: string;
  busy: boolean;
  nativeCliOpen: boolean;
}) {
  return (
    <footer className="chat-column flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-6 py-3 text-[11px] text-muted-foreground">
      <span className="truncate">{branchName}</span>
      <span className={busy ? "text-accent-brand" : "text-success"}>
        {busy ? "● working" : "● ready"}
      </span>
      <span className="flex-1" />
      <span className={nativeCliOpen ? "text-accent-brand" : ""}>
        {nativeCliOpen ? "Native CLI open" : agentName}
      </span>
      <span title="Agent commands">⌘⇧P</span>
    </footer>
  );
}
