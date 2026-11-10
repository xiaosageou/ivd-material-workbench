import { getLiteratureWorkerStatus } from './literature/worker.ts';

const status = getLiteratureWorkerStatus();
if (!status.online) {
  console.error('Literature Worker heartbeat is missing or stale.');
  process.exitCode = 1;
} else {
  console.log(`Literature Worker online; pending parse jobs: ${status.pendingJobs}`);
}
