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

const rowButton = "ph-btn ph-btn-ghost h-7 px-2 text-xs";

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
    <>
      {configError ? (
        <p className="ph-error">{configError}</p>
      ) : config ? (
        <dl className="ph-props">
          <dt>Install</dt>
          <dd className="font-mono text-xs leading-5">{config.install ?? "—"}</dd>
          <dt>Setup</dt>
          <dd className="font-mono text-xs leading-5">{config.setup ?? "from the lockfile"}</dd>
          <dt>Size</dt>
          <dd>{config.vcpu ? `${config.vcpu} vCPU / ${config.vcpu * 4} GB` : "org default"}</dd>
        </dl>
      ) : (
        <p className="ph-hint">Reading powerhouse.toml…</p>
      )}
      <p className="ph-hint">
        From <code>powerhouse.toml</code> on <code>{repo.defaultBranch}</code>. Commit changes there, then build.
      </p>

      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void build()} disabled={!!running} className="ph-btn">
          {running ? `Building… ${running.step}` : "Build VM image"}
        </button>
        <p className="ph-hint min-w-0 flex-1 truncate">
          {active ? `New chats start from build ${active}.` : "No image yet: build one before starting a cloud chat."}
        </p>
      </div>
      {error && <p className="ph-error">{error}</p>}

      {builds.length > 0 && (
        <ul className="ph-list">
          {builds.map((b) => (
            <li key={b.number} className="py-1.5 pl-3 pr-1.5">
              <div className="flex h-7 items-center gap-2.5 text-[13px]">
                <span
                  className={`ph-dot bg-current ${
                    b.status === "failed"
                      ? "text-destructive"
                      : b.number === active
                        ? "tone-running"
                        : b.status === "running"
                          ? "tone-review animate-pulse"
                          : "text-muted-foreground/50"
                  }`}
                  aria-hidden="true"
                />
                <span className="font-medium text-foreground">Build {b.number}</span>
                <span className={`text-xs ${b.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                  {[
                    b.status === "running" ? b.step : b.number === active ? "Active" : b.status.charAt(0).toUpperCase() + b.status.slice(1),
                    b.commit?.slice(0, 7),
                    buildDuration(b),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="flex-1" />
                {b.status === "ready" && b.number !== active && (
                  <button type="button" onClick={() => void activate(b.number)} className={rowButton}>
                    Use this build
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpenLog(openLog === b.number ? null : b.number)}
                  aria-expanded={openLog === b.number}
                  className={rowButton}
                >
                  {openLog === b.number ? "Hide log" : "Log"}
                </button>
              </div>
              {b.error && <p className="ph-error pl-[1.1rem]">{b.error.split("\n")[0]}</p>}
              {openLog === b.number && (
                <pre className="mb-1.5 mr-1.5 mt-2 max-h-64 select-text overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2.5 font-mono text-[11px] leading-relaxed">
                  {b.log.trim() || "…"}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
