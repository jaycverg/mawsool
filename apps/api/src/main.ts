import { buildApp } from './app';
import { loadConfig } from './config';
import { connect } from './db/client';

const config = loadConfig();
const { db, close } = connect(config.databaseUrl);
const app = await buildApp({ db, config, logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(close).then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
