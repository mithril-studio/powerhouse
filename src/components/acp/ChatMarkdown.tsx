import { memo, isValidElement, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import { CopyButton } from "./CopyButton";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

function CodeBlock({ children }: { children?: ReactNode }) {
  const [wrap, setWrap] = useState(false);
  const child = isValidElement<{ className?: string; children?: string }>(children) ? children : null;
  const text = typeof child?.props.children === "string" ? child.props.children : "";
  const language = child?.props.className?.match(/language-([\w+-]+)/)?.[1] ?? "text";
  return <div className="chat-code">
    <div className="code-toolbar">
      <span className="font-mono">{language}</span>
      <span className="flex-1" />
      <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap</button>
      <CopyButton text={text} label="Copy code" />
    </div>
    <pre className={wrap ? "code-wrap" : ""}>{children}</pre>
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

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
  img: ({ alt }) => <span className="text-muted-foreground">[Image: {alt || "external image"} — ask the agent to attach it]</span>,
  table: ({ children }) => <div className="chat-table"><table>{children}</table></div>,
};

/** No raw HTML, automatic remote images, or non-web URL schemes from agents. */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return <div className="chat-markdown select-text">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</Markdown>
  </div>;
});
