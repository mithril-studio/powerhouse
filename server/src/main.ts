import { BoxdExecutionAdapter } from "./adapters/boxd.js";
import { loadConfig } from "./config.js";
import { createCoordinator } from "./coordinator.js";

const config = loadConfig();
const coordinator = await createCoordinator(config, new BoxdExecutionAdapter());

await coordinator.app.listen({ port: config.port, host: config.host });
console.log(`powerhouse coordinator listening on ${config.host}:${config.port}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void coordinator.stop().then(() => process.exit(0));
  });
}
