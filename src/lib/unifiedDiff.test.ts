import { expect, it } from "vitest";
import { parseUnifiedDiff, splitDiffRows } from "./unifiedDiff";

const patch = 'diff --git a/a.ts b/a.ts\nindex abc..def 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +10,3 @@ function run()\n same\n-old\n+new\n+extra\n\\ No newline at end of file\n@@ -30 +31 @@\n-last\n+next\n';
it("counts edits and preserves both line coordinates across hunks", () => {
  const [file] = parseUnifiedDiff(patch);
  expect(file.path).toBe("a.ts");
  expect([file.added, file.removed]).toEqual([3, 2]);
  expect(file.hunks[0].rows.map(r => [r.kind, r.oldLine, r.newLine])).toEqual([
    ["context", 10, 10], ["removed", 11, null], ["added", null, 11], ["added", null, 12], ["note", null, null],
  ]);
  expect(file.hunks[1].rows[0].oldLine).toBe(30);
  expect(file.hunks[1].rows[1].newLine).toBe(31);
});
it("aligns unequal replacements without losing rows", () => {
  const pairs = splitDiffRows(parseUnifiedDiff(patch)[0].hunks[0].rows);
  expect(pairs[1].before?.text).toBe("old");
  expect(pairs[1].after?.text).toBe("new");
  expect(pairs[2].before).toBeNull();
  expect(pairs[2].after?.text).toBe("extra");
});
it("supports added/deleted files, binary metadata and empty patches", () => {
  expect(parseUnifiedDiff("")).toEqual([]);
  const files = parseUnifiedDiff('diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+hello\ndiff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-goodbye\ndiff --git a/icon.png b/icon.png\nBinary files a/icon.png and b/icon.png differ\n');
  expect(files.map(f => [f.path, f.added, f.removed])).toEqual([["new.ts", 1, 0], ["old.ts", 0, 1], ["icon.png", 0, 0]]);
  expect(files[2].metadata[0]).toContain("Binary files");
});
it("treats header-like code inside a hunk as content", () => {
  const [file] = parseUnifiedDiff('--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n--- old\n+++ new\n');
  expect(file.removed).toBe(1);
  expect(file.added).toBe(1);
  expect(file.path).toBe("file.txt");
});
