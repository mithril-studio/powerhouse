import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { queueStepLog } from "../lib/ipc";

interface Props {
  repoId: string;
  entryId: string;
  step: number;
  /** Whether the owning entry is still live (subscribe to streamed chunks). */
  live: boolean;
}

// Rough ANSI/control-sequence stripper — v1 logs are plain text.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const strip = (s: string) => s.replace(ANSI, "").replace(/\r(?!\n)/g, "");

export function StepLog({ repoId, entryId, step, live }: Props) {
  const [text, setText] = useState("");
  const preRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  // Preserve stick-to-bottom unless the user has scrolled up.
  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void queueStepLog(repoId, entryId, step).then((t) => {
      if (!disposed) setText(t);
    });

    if (live) {
      void listen<{ step: number; chunk: string }>(
        `queue-log-${entryId}`,
        (e) => {
          if (e.payload.step === step) {
            setText((prev) => prev + e.payload.chunk);
          }
        },
      ).then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    }

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [repoId, entryId, step, live]);

  useEffect(() => {
    const el = preRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={preRef}
      onScroll={onScroll}
      className="mt-1 max-h-64 select-text overflow-y-auto whitespace-pre-wrap rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
    >
      {strip(text) || (live ? "…" : "no output")}
    </pre>
  );
}
