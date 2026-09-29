import type { HighlighterCore, LanguageInput } from "shiki/core";

const THEMES = { dark: "github-dark", light: "github-light" } as const;

/** The grammars we ship, each its own lazy chunk. Shiki's full bundle would
 *  add ~10 MB of grammars and themes to the app for languages nobody opens. */
const LANGS: Record<string, LanguageInput> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
};

/** Whole filenames that say more than their (missing) extension. */
const FILENAMES: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  ".env": "dotenv",
};

/** Extensions whose language id differs from the extension itself. */
const EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  htm: "html",
  svg: "xml",
  plist: "xml",
  py: "python",
  kt: "kotlin",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  rb: "ruby",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  gql: "graphql",
  cfg: "ini",
  patch: "diff",
};

/** Shiki language id for a worktree path, or null for plain text. */
export function languageFor(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  if (FILENAMES[name]) return FILENAMES[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1);
  const lang = EXTENSIONS[ext] ?? ext;
  return lang in LANGS ? lang : null;
}

export function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

// One highlighter for the app, loaded on the first file view (Shiki stays out
// of the startup bundle); grammars load on first use. The JS regex engine
// avoids shipping and instantiating the Oniguruma WASM.
let highlighter: Promise<HighlighterCore> | null = null;
const getHighlighter = () =>
  (highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [import("shiki/themes/github-dark.mjs"), import("shiki/themes/github-light.mjs")],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })());

/** Highlighted HTML (Shiki escapes the source), one `.line` span per line. */
export async function highlight(
  code: string,
  lang: string | null,
  theme: "dark" | "light",
): Promise<string> {
  const h = await getHighlighter();
  if (lang && !h.getLoadedLanguages().includes(lang)) await h.loadLanguage(LANGS[lang]);
  return h.codeToHtml(code, { lang: lang ?? "text", theme: THEMES[theme] });
}
