import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const cwd = process.cwd();
const tempRoot = path.resolve(tmpdir());
const dataDir = mkdtempSync(path.join(tempRoot, 'ivd-ai-worker-health-'));
if (!dataDir.startsWith(tempRoot + path.sep)) throw new Error('AI Worker health fixture escaped the temporary directory');
const env = { ...process.env, DATA_DIR: dataDir, IVD_AI_API_KEY: '' };
const worker = spawn(process.execPath, ['--experimental-strip-types', 'src/ai-worker.ts'], { cwd, env, stdio: 'ignore' });

try {
  const deadline = Date.now() + 12_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`Isolated AI Worker exited early (${worker.exitCode})`);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/ai-worker-health.ts'], { cwd, env, encoding: 'utf8' });
    if (result.status === 0) { healthy = true; break; }
    if (result.error) throw result.error;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!healthy) throw new Error('Isolated AI Worker did not publish a fresh heartbeat within 12 seconds');
  console.log('ISOLATED AI WORKER HEALTH PASS: temporary DATA_DIR heartbeat verified with no model credentials.');
} finally {
  if (worker.exitCode === null) {
    worker.kill('SIGTERM');
    await Promise.race([new Promise<void>(resolve => worker.once('exit', () => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, 3000))]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  rmSync(dataDir, { recursive: true, force: true });
}
import './test-isolation.mjs';
