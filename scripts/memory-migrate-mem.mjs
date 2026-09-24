#!/usr/bin/env node
// One-shot migration of the repo-local `.mem/domains/*.jsonl` learnings into
// the shared memory as Basic Memory notes. Idempotent: an existing note file
// is left alone. Usage:
//   node scripts/memory-migrate-mem.mjs [<repo root>] [<memory project dir>]
// Defaults: cwd, ~/.powerhouse/memory/projects/<repo dir name>.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const TYPE_MAP = {
  failure: "gotcha",
  convention: "convention",
  pattern: "convention",
  decision: "decision",
  reference: "pointer",
};

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const repoRoot = process.argv[2] ?? process.cwd();
// A worktree's directory is the branch name, not the repo; the memory
// project dir names the project, so prefer it when given.
const memoryDir = process.argv[3] ?? join(homedir(), ".powerhouse", "memory", "projects", slugify(basename(repoRoot)));
const slug = slugify(basename(memoryDir));
const domainsDir = join(repoRoot, ".mem", "domains");

if (!existsSync(domainsDir)) {
  console.error(`no .mem/domains under ${repoRoot}`);
  process.exit(1);
}

const safeTitle = (title) => title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
const yamlList = (items) => (items.length ? `[${items.map((i) => JSON.stringify(i)).join(", ")}]` : "[]");

let written = 0;
let skipped = 0;
for (const file of readdirSync(domainsDir).filter((f) => f.endsWith(".jsonl"))) {
  for (const line of readFileSync(join(domainsDir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.status && record.status !== "active") {
      skipped += 1;
      continue;
    }
    const type = TYPE_MAP[record.type] ?? "convention";
    const dir = join(memoryDir, type);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${safeTitle(record.title)}.md`);
    if (existsSync(target)) {
      skipped += 1;
      continue;
    }
    const evidence = record.evidence ?? {};
    const provenance = record.provenance ?? {};
    const created = provenance.created_at ?? new Date().toISOString();
    const body = [];
    if (type === "gotcha") {
      body.push(`- [cause] ${record.body.trim()} #${record.domain}`);
      if (record.resolution) body.push(`- [fix] ${record.resolution.trim()} #${record.domain}`);
    } else {
      body.push(`- [${type}] ${record.body.trim()} #${record.domain}`);
      if (record.resolution) body.push(`- [how] ${record.resolution.trim()} #${record.domain}`);
    }
    const frontmatter = [
      "---",
      `title: ${JSON.stringify(record.title)}`,
      `type: ${type}`,
      `scope: projects/${slug}`,
      `status: active`,
      `confidence: ${record.confidence ?? "medium"}`,
      `paths: ${yamlList(evidence.files ?? [])}`,
      `domain: ${record.domain}`,
      "provenance:",
      `  agent: ${String(provenance.author ?? "unknown").replace(/^agent:/, "")}`,
      `  branch: ${JSON.stringify(evidence.branch ?? "")}`,
      `  created: ${created}`,
      `  migrated_from: .mem/${record.id}`,
      `modified: ${created}`,
      "---",
      "",
    ];
    writeFileSync(target, `${frontmatter.join("\n")}${body.join("\n")}\n`);
    written += 1;
  }
}
console.log(`memory: wrote ${written} notes to ${memoryDir} (${skipped} skipped)`);
