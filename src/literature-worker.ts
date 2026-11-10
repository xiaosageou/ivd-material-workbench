import { runLiteratureWorker, runLiteratureWorkerOnce } from './literature/worker.ts';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

if (process.env.IVD_LITERATURE_WORKER_ONCE === '1') await runLiteratureWorkerOnce();
else await runLiteratureWorker(controller.signal);
