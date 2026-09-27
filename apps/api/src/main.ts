// Must be first: instrumentation patches modules as they load
import "./tracing";
import { createApp } from "./bootstrap";
import { loadApiEnv } from "./config/env";

async function main(): Promise<void> {
  const env = loadApiEnv();
  const app = await createApp(env);
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
