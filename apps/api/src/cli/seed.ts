import { loadConfig } from '../config';
import { createCipher } from '../crypto';
import { connect } from '../db/client';
import { runSeed } from '../seed/run';
import { urduGap } from '../seed/stats';

const config = loadConfig();
const { db, close } = connect(config.databaseUrl);
try {
  const data = await runSeed(db, createCipher(config.encryptionKey));
  const gap = await urduGap(db);
  console.log(
    `seeded ${data.facilities.length} facilities, ${data.services.length} services, ${data.persons.length} persons, ` +
      `${data.tickets.length} tickets, ${data.ticketEvents.length} events, ${data.crisisEvents.length} crisis events`,
  );
  console.log(`loop-closed: overall ${gap.overallRate.toFixed(1)}%, Urdu ${gap.urduRate.toFixed(1)}%, gap ${gap.gapPoints.toFixed(1)} points`);
} finally {
  await close();
}
