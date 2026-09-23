import pg from "pg";

const { Pool } = pg;

/**
 * Application migrations. Kept inline and append-only: each entry runs once,
 * recorded in `app_migrations`. These tables are product projections; DBOS
 * owns its own schema (`dbos`) in the system database and is the execution
 * authority.
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "001_workflow_runs",
    sql: `
      CREATE TABLE workflow_runs (
        id UUID PRIMARY KEY,
        owner TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        dbos_workflow_id TEXT NOT NULL UNIQUE,
        repo_name TEXT NOT NULL,
        remote_url TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        snapshot_name TEXT NOT NULL,
        snapshot_version TEXT,
        script_1 TEXT NOT NULL,
        script_2 TEXT NOT NULL,
        deadline_seconds BIGINT NOT NULL,
        status TEXT NOT NULL,
        cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner, idempotency_key)
      );

      CREATE TABLE workflow_node_runs (
        id UUID PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES workflow_runs(id),
        node_index INT NOT NULL,
        machine_name TEXT NOT NULL,
        machine_id TEXT,
        manifest_digest TEXT,
        created_at_ms BIGINT NOT NULL,
        state TEXT NOT NULL,
        exit_code INT,
        output_tail TEXT,
        error TEXT,
        machine_released BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (run_id, node_index)
      );

      CREATE TABLE workflow_run_events (
        run_id UUID NOT NULL REFERENCES workflow_runs(id),
        seq BIGINT NOT NULL,
        node_run_id UUID,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (run_id, seq)
      );
    `,
  },
];

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export async function migrate(db: Db): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS app_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  for (const m of MIGRATIONS) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Serialize concurrent migrators.
      await client.query("LOCK TABLE app_migrations IN ACCESS EXCLUSIVE MODE");
      const seen = await client.query("SELECT 1 FROM app_migrations WHERE name = $1", [m.name]);
      if (seen.rowCount === 0) {
        await client.query(m.sql);
        await client.query("INSERT INTO app_migrations (name) VALUES ($1)", [m.name]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
