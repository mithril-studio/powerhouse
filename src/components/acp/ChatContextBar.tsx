import type { AcpUsageItem } from "../../lib/acpTranscript";
import { BranchIcon, CloudIcon, FolderIcon } from "../ui/icons";
import { ContextUsageMeter } from "./ContextUsageMeter";

/** Under the composer: where this chat runs (project, branch, VM) and how full the context is. */
export function ChatContextBar({
  projectName,
  branchName,
  vm,
  usage,
}: {
  projectName?: string;
  branchName: string;
  /** Name of the boxd VM the chat runs on, when it isn't local. */
  vm?: string;
  /** Latest context-window reading; absent until the agent reports one. */
  usage: AcpUsageItem | null;
}) {
  return (
    <footer className="chat-context shrink-0 px-6">
      <div className="chat-column chat-context-row">
        {projectName && (
          <span title="Project">
            <FolderIcon className="size-3.5" />
            <span className="truncate">{projectName}</span>
          </span>
        )}
        <span title="Branch">
          <BranchIcon className="size-3.5" />
          <span className="truncate">{branchName}</span>
        </span>
        {vm && (
          <span title="Runs on a cloud VM">
            <CloudIcon className="size-3.5" />
            <span className="truncate">{vm}</span>
          </span>
        )}
        <span className="flex-1" />
        {usage && <ContextUsageMeter used={usage.used} size={usage.size} barClassName="w-10" />}
      </div>
    </footer>
  );
}
