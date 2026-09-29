import { describe, expect, it } from "vitest";
import { isMarkdown, languageFor } from "./highlight";

describe("languageFor", () => {
  it("maps extensions and special filenames to shipped grammars", () => {
    expect(languageFor("src/App.tsx")).toBe("tsx");
    expect(languageFor("src/lib/ipc.ts")).toBe("typescript");
    expect(languageFor("src-tauri/src/git.rs")).toBe("rust");
    expect(languageFor("Cargo.toml")).toBe("toml");
    expect(languageFor(".github/workflows/beta.yml")).toBe("yaml");
    expect(languageFor("docker/Dockerfile")).toBe("docker");
    expect(languageFor("scripts/release.sh")).toBe("shellscript");
  });

  it("falls back to plain text for unknown or extensionless files", () => {
    expect(languageFor("LICENSE")).toBeNull();
    expect(languageFor("data.bin")).toBeNull();
    expect(languageFor(".gitignore")).toBeNull();
  });
});

describe("isMarkdown", () => {
  it("recognises markdown files case-insensitively", () => {
    expect(isMarkdown("AGENTS.md")).toBe(true);
    expect(isMarkdown("docs/Guide.MARKDOWN")).toBe(true);
    expect(isMarkdown("src/md.ts")).toBe(false);
  });
});
