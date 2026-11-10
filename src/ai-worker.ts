import { runAiWorker, runAiWorkerOnce } from './ai/worker.ts';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

if (process.env.IVD_AI_WORKER_ONCE === '1') {
  await runAiWorkerOnce({ forceReady: process.env.IVD_AI_FORCE_READY === '1' });
} else {
  await runAiWorker(controller.signal);
}
