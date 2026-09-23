import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Disposable Postgres for integration tests: initdb into a temp directory,
 * start on a free port, hand the URL to workers via env, and destroy
 * everything afterwards. Requires `initdb`/`pg_ctl` on PATH (Homebrew
 * postgresql works).
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (typeof address === "object" && address) {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
  });
}

export default async function setup(): Promise<() => void> {
  const dataDir = mkdtempSync(join(tmpdir(), "ph-server-pg-"));
  const port = await freePort();

  execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--no-sync", "-E", "UTF8"], {
    stdio: "ignore",
  });
  const start = spawnSync(
    "pg_ctl",
    [
      "-D",
      dataDir,
      "-w",
      "-o",
      `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
      "-l",
      join(dataDir, "pg.log"),
      "start",
    ],
    { stdio: "ignore" },
  );
  if (start.status !== 0) {
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error("failed to start disposable postgres");
  }

  process.env.PH_TEST_PG_URL = `postgres://postgres@127.0.0.1:${port}`;

  return () => {
    spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    rmSync(dataDir, { recursive: true, force: true });
  };
}
