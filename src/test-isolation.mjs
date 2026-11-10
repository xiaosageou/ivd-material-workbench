import path from 'node:path';

const testEntry = /(?:^|[\\/])(?:smoke|ai-smoke|ai-contract-smoke|report-knowledge-smoke|ai-worker-health-smoke|embedding-contract-smoke|literature-smoke|literature-worker-smoke|literature-qdrant-smoke|literature-index-smoke|literature-boundaries-smoke|suggestion-literature-smoke|migration-smoke|test-isolation-smoke)\.(?:ts|mjs)$/i;

export function assertIsolatedTestDataDir() {
  const entryPath = process.argv[1] || '';
  const isTestEntry = testEntry.test(entryPath);
  const marked = process.env.IVD_TEST_MODE === '1';
  if (isTestEntry && !marked) {
    throw new Error(`Test entry ${path.basename(entryPath)} must run through the isolated test runner (IVD_TEST_MODE=1).`);
  }
  if (!marked) return;
  const configured = String(process.env.DATA_DIR || '').trim();
  if (!configured) throw new Error('IVD_TEST_MODE=1 requires an explicit isolated DATA_DIR before database access.');
  const dataDir = path.resolve(configured);
  const defaultDir = path.resolve(process.cwd(), 'data');
  const relative = path.relative(defaultDir, dataDir);
  const insideDefault = relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  if (insideDefault) throw new Error('IVD_TEST_MODE=1 rejects the project default data directory; use an independent temporary DATA_DIR.');
}

assertIsolatedTestDataDir();
