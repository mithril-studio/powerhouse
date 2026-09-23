import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

const plugins = [remarkGfm];

/** Agent prose rendered as GitHub-flavoured markdown (tables, task lists,
 *  strikethrough, fenced code). Styling lives under `.acp-md` in index.css so
 *  it stays in the Pi terminal palette. Links open in the system browser —
 *  navigating the webview itself would replace the app. */
export const AcpMarkdown = memo(function AcpMarkdown({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`acp-md select-text break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) void openUrl(href).catch(() => {});
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
