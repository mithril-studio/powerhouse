import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffView } from "./DiffView";

it("shows review controls and numbered, escaped changes", () => {
  const html = renderToStaticMarkup(<DiffView diff={'--- a/file.ts\n+++ b/file.ts\n@@ -4 +4 @@\n-const old = 1;\n+const next = "<script>";\n'} />);
  expect(html).toContain('aria-label="1 additions"');
  expect(html).toContain('aria-label="1 deletions"');
  expect(html).toContain('aria-label="Diff layout"');
  expect(html).toContain("Split");
  expect(html).toContain("Copy diff");
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('aria-label="Change 1"');
});
