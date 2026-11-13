import { CloudRunCard } from "../../components/CloudPane";
import { useAppStore } from "../../store/appStore";
import { importTaskCloudResult } from "./taskActions";
import type { Task } from "./types";

export function TaskCloudDetails({ task }: { task: Task }) {
  const record = useAppStore((state) => state.cloudRuns[task.cloudRunId ?? ""]);
  if (!record || record.repo_id !== task.repoId)
    return (
      <p className="text-sm text-muted-foreground">Cloud run unavailable.</p>
    );
  return (
    <CloudRunCard
      key={record.run_id}
      record={record}
      defaultExpanded
      onImport={() => importTaskCloudResult(task.id)}
    />
  );
}
