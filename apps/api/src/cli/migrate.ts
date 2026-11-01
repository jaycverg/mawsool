import { loadConfig } from '../config';
import { migrateDatabase } from '../db/migrate';

const { databaseUrl } = loadConfig();
await migrateDatabase(databaseUrl);
console.log('migrations applied');
