import { createAnthropicProvider } from '@mawsool/summary';
import { buildApp } from './app';
import { loadConfig } from './config';
import { connect } from './db/client';
import { startJobs } from './jobs';
import { systemClock } from './clock';

// Config is read first: with no encryption key (or a bad one) this throws before a database is touched.
const config = loadConfig();
const { db, close } = connect(config.databaseUrl);
const summaryProvider = config.summaryLlmEnabled ? createAnthropicProvider({ apiKey: config.anthropicApiKey!, model: config.summaryModel }) : null;
const app = await buildApp({ db, config, logger: true, summaryProvider });
const jobs = await startJobs({ databaseUrl: config.databaseUrl, db, clock: systemClock, log: app.log });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void jobs.stop().then(() => app.close()).then(close).then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
