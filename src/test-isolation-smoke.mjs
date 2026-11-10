import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'ivd-test-guard-fixture-'));
const fakeDefault = path.join(fixtureRoot, 'data');
const guardUrl = new URL('./test-isolation.mjs', import.meta.url).href;
try {
  const source = `process.argv[1]='guard-probe'; await import(${JSON.stringify(guardUrl)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: fixtureRoot,
    env: { ...process.env, IVD_TEST_MODE: '1', DATA_DIR: fakeDefault },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'marked test import rejects a fake project-default DATA_DIR');
  assert.match(`${result.stdout}\n${result.stderr}`, /rejects the project default data directory/i);
  assert.equal(existsSync(fakeDefault), false, 'guard fails before creating the fake default directory');

  const missing = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: fixtureRoot,
    env: { ...process.env, IVD_TEST_MODE: '1', DATA_DIR: '' },
    encoding: 'utf8',
  });
  assert.notEqual(missing.status, 0, 'marked test import rejects a missing DATA_DIR');
  assert.match(`${missing.stdout}\n${missing.stderr}`, /requires an explicit isolated DATA_DIR/i);

  const directSource = `process.argv[1]=${JSON.stringify(path.join(root, 'src', 'smoke.ts'))}; await import(${JSON.stringify(guardUrl)});`;
  const directEntry = spawnSync(process.execPath, ['--input-type=module', '--eval', directSource], {
    cwd: fixtureRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['IVD_TEST_MODE', 'DATA_DIR'].includes(key))),
    encoding: 'utf8',
  });
  assert.notEqual(directEntry.status, 0, 'direct test invocation without runner is rejected');
  assert.match(`${directEntry.stdout}\n${directEntry.stderr}`, /must run through the isolated test runner/i);
  assert.equal(existsSync(fakeDefault), false, 'direct-entry guard does not create the fake default directory');
  const stripOnlyEntry = spawnSync(process.execPath, ['--experimental-strip-types', path.join(root, 'src', 'migration-smoke.ts')], {
    cwd: fixtureRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['IVD_TEST_MODE', 'DATA_DIR'].includes(key))),
    encoding: 'utf8',
  });
  assert.notEqual(stripOnlyEntry.status, 0, 'strip-only direct test entry is rejected before opening SQLite');
  assert.match(`${stripOnlyEntry.stdout}\n${stripOnlyEntry.stderr}`, /must run through the isolated test runner/i);
  assert.equal(existsSync(fakeDefault), false, 'strip-only direct-entry guard does not create a fake default directory');
  process.stdout.write('TEST ISOLATION GUARD PASS: explicit isolated DATA_DIR required before DB access; fake default and direct-entry probes rejected before directory creation.\n');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
