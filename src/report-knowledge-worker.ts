import { runReportKnowledgeWorker, processReportKnowledgeIndexOnce, enqueueAllCurrentReportKnowledge, reconcileReportKnowledgeIndexAfterRestore } from './report-knowledge.ts';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

if (process.env.IVD_REPORT_KNOWLEDGE_WORKER_ONCE === '1') {
  enqueueAllCurrentReportKnowledge();
  await reconcileReportKnowledgeIndexAfterRestore();
  let processed = 0;
  while (processed < 200 && await processReportKnowledgeIndexOnce()) processed++;
  process.stdout.write(`REPORT KNOWLEDGE WORKER ONCE: processed ${processed} queued/recoverable jobs.\n`);
} else await runReportKnowledgeWorker(controller.signal);
