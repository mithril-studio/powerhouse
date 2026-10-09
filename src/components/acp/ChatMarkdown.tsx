import { useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState("Copy code");
  return <div className="chat-code">
    <button type="button" onClick={async () => {
      try {
        await navigator.clipboard.writeText(code.current?.textContent ?? "");
        setStatus("Copied");
      } catch { setStatus("Could not copy"); }
    }}>{status}</button>
    <pre ref={code}>{children}</pre>
  </div>;
}

function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  const [error, setError] = useState(false);
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return <>
    <a href={href} rel="noreferrer" onClick={(event) => {
      event.preventDefault();
      setError(false);
      void openUrl(href).catch(() => setError(true));
    }}>{children}</a>
    {error && <span role="status"> Could not open link.</span>}
  </>;
}

/** No raw HTML, automatic remote images, or non-web URL schemes from agents. */
export function ChatMarkdown({ text }: { text: string }) {
  return <div className="chat-markdown select-text">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
      img: ({ alt }) => <span className="text-muted-foreground">[Image: {alt || "external image"} — ask the agent to attach it]</span>,
      table: ({ children }) => <div className="chat-table"><table>{children}</table></div>,
    }}>{text}</Markdown>
  </div>;
}
