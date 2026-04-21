import 'dotenv/config';

import { readConfig } from '../../../packages/config/src/index.js';
import { createApiApp } from './app.js';

async function main(): Promise<void> {
  const config = readConfig();
  const { app } = await createApiApp(config);

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Phantom3 v2 listening on ${config.publicBaseUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
