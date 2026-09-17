import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./index.css";

// Dev aid: pipe webview errors to the `tauri dev` terminal.
if (import.meta.env.DEV) {
  const send = (level: string, msg: string) =>
    void invoke("js_log", { level, msg }).catch(() => {});
  window.addEventListener("error", (e) =>
    send("error", `${e.message} @ ${e.filename}:${e.lineno}`),
  );
  window.addEventListener("unhandledrejection", (e) =>
    send("rejection", String(e.reason?.stack ?? e.reason)),
  );
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    send("console.error", args.map(String).join(" "));
    origError(...args);
  };
  send("info", `boot ok — tauri internals present: ${"__TAURI_INTERNALS__" in window}`);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
