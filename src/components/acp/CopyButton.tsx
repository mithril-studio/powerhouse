import { useEffect, useRef, useState } from "react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button type="button" className="copy-button" aria-label={status ?? label} onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setStatus("Copied");
      } catch { setStatus("Could not copy"); }
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus(null), 2000);
    }}>
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" className="size-3.5"><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M10 3H4a1 1 0 0 0-1 1v6" /></svg>
      <span>{status ?? label}</span>
    </button>
  );
}
