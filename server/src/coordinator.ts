import { DBOS } from "@dbos-inc/dbos-sdk";
import type { FastifyInstance } from "fastify";

import type { ExecutionAdapter } from "./adapters/types.js";
import { buildApp } from "./api.js";
import type { ServerConfig } from "./config.js";
import { createPool, migrate, type Db } from "./db.js";
import { markDispatched, undispatchedRuns, type RunRow } from "./runs.js";
import { setWorkflowDeps, sequenceWorkflow } from "./workflow.js";

export interface Coordinator {
  app: FastifyInstance;
  db: Db;
  stop(): Promise<void>;
}

/**
 * Assemble one coordinator instance: migrations, DBOS (which recovers any
 * PENDING workflows for this executor at launch), the dispatch reconciler
 * for runs admitted but never handed to DBOS, and the HTTP API.
 */
export async function createCoordinator(
  config: ServerConfig,
  adapter: ExecutionAdapter,
): Promise<Coordinator> {
  const db = createPool(config.databaseUrl);
  await migrate(db);

  setWorkflowDeps({ db, adapter, pollIntervalMs: config.pollIntervalMs });

  DBOS.setConfig({
    name: "powerhouse-coordinator",
    // Pinned so a restarted coordinator recovers workflows it started.
    applicationVersion: "0.1.0",
    systemDatabaseUrl: config.systemDatabaseUrl,
  });
  await DBOS.launch();

  const dispatch = async (run: RunRow): Promise<void> => {
    // The DBOS workflow ID was committed with the run; starting again with
    // the same ID and function is idempotent and adopts the existing workflow.
    await DBOS.startWorkflow(sequenceWorkflow, {
      workflowID: run.dbos_workflow_id,
    })(run.id);
    await markDispatched(db, run.id);
  };

  // Repair admissions that crashed between commit and dispatch.
  for (const run of await undispatchedRuns(db)) {
    await dispatch(run);
  }

  const app = buildApp({ db, config, dispatch });

  return {
    app,
    db,
    async stop() {
      await app.close();
      await DBOS.shutdown();
      await db.end();
    },
  };
}
