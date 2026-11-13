export interface DiffRow {
  kind: "context" | "added" | "removed" | "note";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}
export interface DiffHunk { header: string; rows: DiffRow[] }
export interface DiffFile { path: string; metadata: string[]; hunks: DiffHunk[]; added: number; removed: number }

function filePath(value: string) {
  const path = value.split("\t")[0];
  let decoded = path;
  if (path.startsWith('"')) {
    try { decoded = JSON.parse(path) as string; } catch { decoded = path.slice(1, -1); }
  }
  return decoded.replace(/^[ab]\//, "");
}

/** Interpret hunk coordinates; header lines must never count as edits. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  const startFile = (path: string) => {
    file = { path, metadata: [], hunks: [], added: 0, removed: 0 };
    files.push(file);
    hunk = undefined;
  };
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      startFile(filePath(line.match(/ ("?b\/.*)$/)?.[1] ?? "Changes"));
      continue;
    }
    if (!file) startFile("Changes");
    const current = file!;
    const coordinates = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (coordinates) {
      oldLine = Number(coordinates[1]);
      newLine = Number(coordinates[2]);
      hunk = { header: line, rows: [] };
      current.hunks.push(hunk);
    } else if (hunk && line.startsWith("+")) {
      hunk.rows.push({ kind: "added", text: line.slice(1), oldLine: null, newLine: newLine++ });
      current.added++;
    } else if (hunk && line.startsWith("-")) {
      hunk.rows.push({ kind: "removed", text: line.slice(1), oldLine: oldLine++, newLine: null });
      current.removed++;
    } else if (hunk && line.startsWith(" ")) {
      hunk.rows.push({ kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (hunk && line.startsWith("\\")) {
      hunk.rows.push({ kind: "note", text: line, oldLine: null, newLine: null });
    } else if (!hunk && (line.startsWith("+++ ") || line.startsWith("--- "))) {
      const path = filePath(line.slice(4));
      if (path !== "/dev/null") current.path = path;
    } else if (line) {
      current.metadata.push(line);
    }
  }
  return files;
}

export interface SplitRow { before: DiffRow | null; after: DiffRow | null }

/** Align replacements within an edit block, padding unequal sides with gaps. */
export function splitDiffRows(rows: DiffRow[]): SplitRow[] {
  const result: SplitRow[] = [];
  let removed: DiffRow[] = [];
  let added: DiffRow[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      result.push({ before: removed[i] ?? null, after: added[i] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const row of rows) {
    if (row.kind === "removed") removed.push(row);
    else if (row.kind === "added") added.push(row);
    else {
      flush();
      result.push({ before: row, after: row });
    }
  }
  flush();
  return result;
}
