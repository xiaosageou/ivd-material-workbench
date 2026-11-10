import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`LITERATURE SMOKE FAIL: ${message}`); };
const equal = (actual: unknown, expected: unknown, message: string) => assert(actual === expected, `${message} (actual=${actual}, expected=${expected})`);

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as net.AddressInfo).port;
  probe.close();
  await once(probe, 'close');
  return port;
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', value => output += value);
    child.stderr.on('data', value => output += value);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(output || `${args.join(' ')} exited ${code}`)));
  });
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'ivd-literature-smoke-'));
const restoreDir = mkdtempSync(path.join(tmpdir(), 'ivd-literature-restore-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), IVD_AI_API_KEY: '', IVD_EMBEDDING_API_KEY: '',
  ADMIN_NAME: '文献测试管理员', ADMIN_EMAIL: 'literature-admin@example.test', ADMIN_PASSWORD: 'literature-admin-password-long' };
let server: ReturnType<typeof spawn> | undefined;
let serverOutput = '';
let adminCookie = '';
let memberCookie = '';
let otherCookie = '';

const call = async (url: string, body?: any, method = 'GET', cookie = adminCookie) => {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json() : await response.arrayBuffer();
  return { response, status: response.status, data };
};
const login = async (email: string, password: string) => {
  const result = await call('/api/auth/login', { email, password }, 'POST', '');
  equal(result.status, 200, `合成账户登录 ${email}`);
  return (result.response.headers.get('set-cookie') || '').split(';')[0];
};
const txt = (name: string, content: string, type = 'text/plain') => new Blob([content], { type });

async function waitForHealth() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* Server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Literature smoke server did not start: ${serverOutput}`);
}

try {
  await run(['src/cli.ts', 'admin-init'], env);
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout?.on('data', value => serverOutput += value);
  server.stderr?.on('data', value => serverOutput += value);
  await waitForHealth();
  adminCookie = await login('literature-admin@example.test', 'literature-admin-password-long');
  for (const [name, email] of [['文献作者', 'literature-author@example.test'], ['只读成员', 'literature-reader@example.test']] as const) {
    const result = await call('/api/users', { name, email, role: 'RESEARCHER', password: 'literature-member-password-long' }, 'POST');
    equal(result.status, 201, `创建合成组织成员 ${email}`);
  }
  memberCookie = await login('literature-author@example.test', 'literature-member-password-long');
  otherCookie = await login('literature-reader@example.test', 'literature-member-password-long');

  const secret = 'synthetic-embedding-secret';
  equal((await call('/api/admin/literature/embedding-config', { apiKey: secret }, 'PATCH', memberCookie)).status, 403, '成员不可配置密钥');
  const savedKey = await call('/api/admin/literature/embedding-config', { apiKey: secret }, 'PATCH');
  equal(savedKey.status, 200, '管理员可保存向量密钥');
  equal(savedKey.data.embedding.keyConfigured, true, '显示密钥配置状态');
  assert(!JSON.stringify(savedKey.data).includes(secret), '响应不包含密钥');
  equal(readFileSync(path.join(dataDir, 'embedding-api-key'), 'utf8'), secret, '密钥保存在共享数据目录');
  const keyDb = new DatabaseSync(path.join(dataDir, 'ivd.sqlite'), { readOnly: true });
  assert(!JSON.stringify(keyDb.prepare('SELECT * FROM system_settings').all()).includes(secret), '设置表不保存密钥');
  assert(!JSON.stringify(keyDb.prepare('SELECT * FROM audit_events').all()).includes(secret), '审计记录不保存密钥');
  keyDb.close();
  rmSync(path.join(dataDir, 'embedding-api-key'));

  const collection = await call('/api/literature/collections', { name: '蛋白定量', description: '合成测试集合' }, 'POST');
  equal(collection.status, 201, '管理员创建文献集合');
  const collectionId = collection.data.id;

  const batch = new FormData();
  batch.set('records', JSON.stringify([
    { title: 'SYN-01 蛋白定量对照研究', authors: ['Synthetic Author A', 'Synthetic Author B'], year: 2024,
      journal: 'Synthetic Journal', doi: 'https://doi.org/10.5555/SYNTH.001', abstract: '人工合成摘要：研究蛋白定量的验证范围。',
      keywords: ['蛋白', '定量'], tags: ['方法学'], collectionIds: [collectionId] },
    { title: '单份格式错误的模拟PDF', year: 2023 },
  ]));
  batch.append('files', txt('SYN-01-paper.txt', '第一段：人工合成文献正文，包含蛋白定量研究背景。\n第二段：重复测定条件由作者报告。'), 'SYN-01-paper.txt');
  batch.append('files', new Blob(['not a pdf'], { type: 'application/pdf' }), 'broken.pdf');
  const upload = await call('/api/literature', batch, 'POST', memberCookie);
  equal(upload.status, 207, '批次部分成功时保留逐文件结果');
  equal(upload.data.successCount, 1, '有效文献按条目创建');
  equal(upload.data.failureCount, 1, '损坏扩展名文件被单独标记失败');
  const item = upload.data.results.find((row: any) => row.ok).item;
  const itemId = String(item.id);
  equal(item.can_edit, 1, '创建者获得编辑权限');
  equal(item.currentVersion.extension, '.txt', '全文版本正确识别 TXT 格式');
  equal(item.currentVersion.sha256, createHash('sha256').update('第一段：人工合成文献正文，包含蛋白定量研究背景。\n第二段：重复测定条件由作者报告。').digest('hex'), '正文文件保存 SHA-256');
  assert(upload.data.results.find((row: any) => !row.ok).error.includes('与扩展名不匹配'), '损坏文献格式说明按文件返回');

  const list = await call('/api/literature?q=' + encodeURIComponent('蛋白定量'), undefined, 'GET', otherCookie);
  equal(list.status, 200, '组织成员可共享检索文献');
  assert(list.data.rows.some((row: any) => row.id === itemId), '中文书目关键词检索命中');
  assert(list.data.rows[0].can_edit === 0, '其他成员返回只读能力');
  const detail = await call(`/api/literature/${itemId}`, undefined, 'GET', otherCookie);
  equal(detail.status, 200, '非作者可查看文献详情');
  equal(detail.data.collections[0].id, collectionId, '文献集合关联保存');
  equal(detail.data.tags[0].name, '方法学', '分类标签关联保存');
  const download = await call(`/api/literature/${itemId}/versions/${item.currentVersion.id}/download`, undefined, 'GET', otherCookie);
  equal(download.status, 200, '登录成员可下载文献全文');
  equal(createHash('sha256').update(Buffer.from(download.data)).digest('hex'), item.currentVersion.sha256, '下载文件 SHA 与记录一致');

  equal((await call(`/api/literature/${itemId}`, { expectedRevision: 1, title: '不应被只读成员修改' }, 'PATCH', otherCookie)).status, 403, '服务端拒绝非作者成员编辑');
  const memberEdit = await call(`/api/literature/${itemId}`, { expectedRevision: 1, title: 'SYN-01 蛋白定量确认研究', abstract: '管理员和作者可维护的人工摘要。' }, 'PATCH', memberCookie);
  equal(memberEdit.status, 200, '创建者可以通过乐观修订更新书目信息');
  equal(memberEdit.data.revision, 2, '书目修订号递增');
  equal((await call(`/api/literature/${itemId}`, { expectedRevision: 1, title: '过期页面覆盖' }, 'PATCH', adminCookie)).status, 409, '旧修订号不能覆盖新元数据');
  const duplicate = new FormData();
  duplicate.set('records', JSON.stringify([{ title: '相同DOI的合成文献', doi: '10.5555/synth.001' }]));
  duplicate.append('files', txt('duplicate.md', '# Duplicate metadata\n摘要候选。'), 'duplicate.md');
  const duplicateResult = await call('/api/literature', duplicate, 'POST', adminCookie);
  equal(duplicateResult.status, 201, '相同 DOI 的文献仍由用户明确创建');
  assert(duplicateResult.data.results[0].duplicates.some((row: any) => row.id === itemId && row.reason === 'doi'), 'DOI 重复仅提示候选，不静默覆盖');

  const replacement = new FormData();
  replacement.set('expectedRevision', '2');
  replacement.set('changeNote', '上传修订文本');
  replacement.append('file', txt('SYN-01-paper-v2.md', '# 第二版\n新增人工合成结果与方法说明。', 'text/markdown'), 'SYN-01-paper-v2.md');
  const replaced = await call(`/api/literature/${itemId}/versions`, replacement, 'POST', memberCookie);
  equal(replaced.status, 201, '作者上传新全文修订版');
  equal(replaced.data.item.versions.length, 2, '替换保留旧文件版本');
  equal(replaced.data.item.currentVersion.version_no, 2, '新全文成为当前版本');
  equal(replaced.data.item.revision, 3, '文件替换同时递增元数据修订号');
  const oldDownload = await call(`/api/literature/${itemId}/versions/${item.currentVersion.id}/download`, undefined, 'GET', otherCookie);
  equal(oldDownload.status, 200, '旧版本仍可查看和下载');
  const newDownload = await call(`/api/literature/${itemId}/versions/${replaced.data.item.currentVersion.id}/download`, undefined, 'GET', otherCookie);
  equal(newDownload.status, 200, '新版本可查看和下载');

  const deleted = await call(`/api/literature/${itemId}`, { expectedRevision: 3 }, 'DELETE', memberCookie);
  equal(deleted.status, 200, '作者软删除文献');
  equal((await call(`/api/literature/${itemId}`, undefined, 'GET', otherCookie)).status, 404, '软删除后组织成员详情失效');
  equal((await call(`/api/literature/${itemId}/versions/${replaced.data.item.currentVersion.id}/download`, undefined, 'GET', otherCookie)).status, 404,
    '软删除后历史全文下载失效');
  const restored = await call(`/api/literature/${itemId}/restore`, {}, 'POST', adminCookie);
  equal(restored.status, 200, '管理员可恢复文献');
  equal(restored.data.currentVersion.version_no, 2, '恢复后当前全文版本保持不变');

  const collectionArchive = await call(`/api/literature/collections/${collectionId}`, undefined, 'DELETE', adminCookie);
  equal(collectionArchive.status, 200, '归档集合');
  equal((await call(`/api/literature/${itemId}`, undefined, 'GET', otherCookie)).status, 200, '归档集合不会删除其中的文献');

  const backup = await call('/api/admin/backups', {}, 'POST', adminCookie);
  equal(backup.status, 200, '管理员为隔离文献库创建备份');
  assert(typeof backup.data.filename === 'string', '备份返回可恢复文件名');
  const archivePath = path.join(dataDir, 'backups', String(backup.data.filename));
  await run(['src/restore.ts', `--file=${archivePath}`], { ...env, DATA_DIR: restoreDir });
  const restoredDb = new DatabaseSync(path.join(restoreDir, 'ivd.sqlite'));
  try {
    equal(restoredDb.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok', '恢复数据库完整性');
    const versions = restoredDb.prepare('SELECT storage_key,sha256 FROM literature_file_versions WHERE item_id=? ORDER BY version_no').all(itemId) as any[];
    equal(versions.length, 2, '备份恢复包含历史文献版本');
    for (const version of versions) {
      const bytes = readFileSync(path.join(restoreDir, 'attachments', version.storage_key));
      equal(createHash('sha256').update(bytes).digest('hex'), version.sha256, `恢复文件校验 ${version.storage_key}`);
    }
  } finally { restoredDb.close(); }

  console.log('LITERATURE SMOKE PASS: 隔离数据库迁移、批次逐份上传、书目/DOI候选、中文关键词检索、创建者/管理员权限、409修订冲突、全文版本与安全下载、软删除/恢复、集合与标签、备份恢复及全部文献文件SHA-256均通过。');
} finally {
  if (server) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2500))]);
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(restoreDir, { recursive: true, force: true });
}
import './test-isolation.mjs';
