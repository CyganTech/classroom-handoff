import { createApp } from './app.js';

const app = createApp();
try {
  const address = await app.listen();
  console.info(`Classroom Handoff listening on ${address.host}:${address.port}; public origin ${app.config.publicUrl}`);
} catch {
  console.error('Could not start Classroom Handoff. Check configuration and data directory permissions.');
  await app.close(); process.exitCode = 1;
}
let stopping = false;
async function shutdown(): Promise<void> { if (stopping) return; stopping = true; await app.close(); }
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
