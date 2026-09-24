import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Last line of defense: a render error anywhere in the tree would otherwise
 *  unmount the root and leave a blank window with no way to recover. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught render error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 font-mono">
        <h1 className="text-sm font-semibold text-foreground">Something broke in the UI</h1>
        <pre className="max-h-64 max-w-2xl overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
          {String(this.state.error.stack ?? this.state.error)}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-muted"
        >
          Reload app
        </button>
      </div>
    );
  }
}
