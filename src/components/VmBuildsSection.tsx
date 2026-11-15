import { useEffect, useState } from "react";
import type { Repo } from "../store/appStore";
import {
  buildDuration,
  mergeBuild,
  onVmBuild,
  vmBuildActivate,
  vmBuildStart,
  vmBuilds,
  vmConfig,
  type VmBuild,
  type VmConfig,
} from "../lib/vmBuilds";

const button =
  "h-8 shrink-0 rounded-lg border border-border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";

/**
 * Project settings → Cloud VM: what `powerhouse.toml` says, the build button,
 * the running build's log, and the build history with the active build.
 */
export function VmBuildsSection({ repo }: { repo: Repo }) {
  const [builds, setBuilds] = useState<VmBuild[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [config, setConfig] = useState<VmConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    vmBuilds(repo.id)
      .then((r) => {
        if (cancelled) return;
        setBuilds(r.builds);
        setActive(r.active);
      })
      .catch((e) => setError(String(e)));
    vmConfig(repo.path, repo.defaultBranch)
      .then((c) => !cancelled && (setConfig(c), setConfigError(null)))
      .catch((e) => !cancelled && setConfigError(String(e)));
    const unlisten = onVmBuild((b) => {
      if (b.repoId !== repo.id) return;
      setBuilds((list) => mergeBuild(list, b));
      if (b.status !== "running") {
        void vmBuilds(repo.id).then((r) => {
          setBuilds(r.builds);
          setActive(r.active);
        });
      }
    });
    return () => {
      cancelled = true;
      void unlisten.then((stop) => stop());
    };
  }, [repo.id, repo.path, repo.defaultBranch]);

  const running = builds.find((b) => b.status === "running");

  async function build() {
    setError(null);
    try {
      const b = await vmBuildStart({
        repoId: repo.id,
        repoName: repo.name,
        repoPath: repo.path,
        branch: repo.defaultBranch,
        envNames: repo.cloudEnvNames ?? [],
      });
      setBuilds((list) => mergeBuild(list, b));
      setOpenLog(b.number);
    } catch (e) {
      setError(String(e));
    }
  }

  async function activate(n: number) {
    setError(null);
    try {
      const r = await vmBuildActivate(repo.id, n);
      setActive(r.active);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="rounded-lg border border-border px-3 py-2">
        {configError ? (
          <p className="text-destructive">{configError}</p>
        ) : config ? (
          <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Install</dt>
            <dd className="truncate font-mono">{config.install ?? "—"}</dd>
            <dt className="text-muted-foreground">Setup</dt>
            <dd className="truncate font-mono">{config.setup ?? "from the lockfile"}</dd>
            <dt className="text-muted-foreground">Size</dt>
            <dd>{config.vcpu ? `${config.vcpu} vCPU / ${config.vcpu * 4} GB` : "org default"}</dd>
          </dl>
        ) : (
          <p className="text-muted-foreground">Reading powerhouse.toml…</p>
        )}
        <p className="mt-2 text-muted-foreground">
          From <code>powerhouse.toml</code> on <code>{repo.defaultBranch}</code>. Commit changes there, then build.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => void build()} disabled={!!running} className={button}>
          {running ? `Building… ${running.step}` : "Build VM image"}
        </button>
        <p className="min-w-0 flex-1 truncate text-muted-foreground">
          {active
            ? `New chats start from build ${active}.`
            : "No image yet: build one before starting a cloud chat."}
        </p>
      </div>
      {error && <p className="text-destructive">{error}</p>}

      {builds.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {builds.map((b) => (
            <li key={b.number} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">Build {b.number}</span>
                <span
                  className={`flex items-center gap-1.5 ${
                    b.status === "failed"
                      ? "text-destructive"
                      : b.number === active
                        ? "tone-running"
                        : b.status === "running"
                          ? "tone-review"
                          : "text-muted-foreground"
                  }`}
                >
                  <span className="ph-dot bg-current" aria-hidden="true" />
                  {b.status === "running" ? b.step : b.number === active ? "Active" : b.status.charAt(0).toUpperCase() + b.status.slice(1)}
                </span>
                <span className="font-mono text-muted-foreground">
                  {b.commit ? `${b.commit.slice(0, 7)} · ` : ""}
                  {buildDuration(b)}
                </span>
                <span className="flex-1" />
                {b.status === "ready" && b.number !== active && (
                  <button onClick={() => void activate(b.number)} className="text-muted-foreground hover:text-foreground">
                    Use this build
                  </button>
                )}
                <button
                  onClick={() => setOpenLog(openLog === b.number ? null : b.number)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {openLog === b.number ? "Hide log" : "Log"}
                </button>
              </div>
              {b.error && <p className="mt-1 text-destructive">{b.error.split("\n")[0]}</p>}
              {openLog === b.number && (
                <pre className="mt-2 max-h-64 select-text overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2.5 font-mono text-[11px] leading-relaxed">
                  {b.log.trim() || "…"}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
