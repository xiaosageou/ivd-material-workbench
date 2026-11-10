import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mode = args.shift();
const entry = args.shift();
if (!['tsx', 'strip', 'mjs'].includes(mode || '') || !entry) {
  process.stderr.write('Usage: node src/test-runner.mjs <tsx|strip|mjs> <test-entry> [args...]\n');
  process.exit(2);
}

const providedDataDir = String(process.env.DATA_DIR || '').trim();
let ownedDataDir = '';
let dataDir = providedDataDir;
if (process.env.IVD_TEST_MODE === '1') {
  if (!dataDir) throw new Error('IVD_TEST_MODE=1 requires an explicit isolated DATA_DIR.');
  const resolved = path.resolve(dataDir);
  const defaultDir = path.resolve(root, 'data');
  const relative = path.relative(defaultDir, resolved);
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('IVD_TEST_MODE=1 rejects the project default data directory.');
  }
} else {
  ownedDataDir = mkdtempSync(path.join(os.tmpdir(), 'ivd-test-run-'));
  dataDir = ownedDataDir;
}

const commandArgs = mode === 'tsx'
  ? ['--import', 'tsx', entry, ...args]
  : mode === 'strip'
    ? ['--experimental-strip-types', entry, ...args]
    : [entry, ...args];
const child = spawn(process.execPath, commandArgs, { cwd: root, env: { ...process.env, IVD_TEST_MODE: '1', DATA_DIR: dataDir }, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
});
if (ownedDataDir) rmSync(ownedDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
process.exit(Number(code));
