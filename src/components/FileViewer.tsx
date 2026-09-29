import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import { gitFileContent } from "../lib/ipc";
import { highlight, isMarkdown, languageFor } from "../lib/highlight";
import { AcpMarkdown } from "./acp/AcpMarkdown";

interface Props {
  worktreePath: string;
  path: string;
}

/** Read-only view of one worktree file: rendered markdown, or highlighted
 *  source with line numbers. Re-reads on window focus so agent edits show up. */
export function FileViewer({ worktreePath, path }: Props) {
  const theme = useAppStore((s) => s.settings.theme);
  const markdown = isMarkdown(path);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [source, setSource] = useState(false);

  const load = useCallback(() => {
    void gitFileContent(worktreePath, path)
      .then((c) => {
        setContent(c);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [worktreePath, path]);

  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const showSource = !markdown || source;
  useEffect(() => {
    if (content === null || !showSource) return;
    let cancelled = false;
    void highlight(content, languageFor(path), theme)
      .then((h) => !cancelled && setHtml(h))
      .catch(() => !cancelled && setHtml(null));
    return () => {
      cancelled = true;
    };
  }, [content, path, theme, showSource]);

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" dir="rtl">
          {path}
        </span>
        {markdown && (
          <div className="flex rounded-md bg-muted/50 p-0.5 text-xs">
            {(["Preview", "Source"] as const).map((label) => {
              const on = (label === "Source") === source;
              return (
                <button
                  key={label}
                  onClick={() => setSource(label === "Source")}
                  aria-pressed={on}
                  className={`rounded px-2 py-0.5 ${
                    on ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        <button
          onClick={load}
          title="Reload from disk"
          aria-label="Reload file"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ↻
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="select-text px-4 py-3 font-mono text-xs text-destructive">{error}</p>
        ) : content === null ? null : !showSource ? (
          <AcpMarkdown text={content} className="file-md mx-auto max-w-3xl px-6 py-5" />
        ) : html ? (
          <div className="file-code select-text" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="select-text whitespace-pre px-4 py-3 font-mono text-xs leading-relaxed">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
