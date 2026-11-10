import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { createServer } from 'node:http';

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`LITERATURE INDEX SMOKE FAIL: ${message}`); };
const equal = (actual: unknown, expected: unknown, message: string) => assert(actual === expected, `${message} (actual=${actual}, expected=${expected})`);
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port; server.close(); await once(server, 'close'); return port;
}
function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(new Error(output || `${args.join(' ')} exited ${code}`)));
  });
}
async function readJson(request: any) {
  const chunks: Buffer[] = []; for await (const chunk of request as any) chunks.push(Buffer.from(chunk as any));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const fixtureRequests: Array<{ model: string; input: string[]; auth: string }> = [];
let provideQueryUsage = false;
let embeddingGateMatch = '';
let embeddingGateArrived: (() => void) | undefined;
let embeddingGateRelease: (() => void) | undefined;
let embeddingGateReleased: Promise<void> | undefined;
const embeddingServer = createServer(async (request, response) => {
  const body = await readJson(request);
  const input: string[] = Array.isArray(body.input) ? body.input.map((value: unknown) => String(value)) : [String(body.input || '')];
  fixtureRequests.push({ model: String(body.model), input, auth: String(request.headers.authorization || '') });
  if (embeddingGateMatch && input.some(value => value.includes(embeddingGateMatch))) {
    embeddingGateMatch = '';
    embeddingGateArrived?.();
    await embeddingGateReleased;
    embeddingGateRelease = undefined;
    embeddingGateReleased = undefined;
    embeddingGateArrived = undefined;
  }
  const unknownUsage = input.some(value => value.startsWith('DOC_NO_USAGE::') || value.startsWith('QUERY_NO_USAGE::'))
    && !(provideQueryUsage && input.some(value => value.startsWith('QUERY_NO_USAGE::')));
  const data = input.map((_value: string, index: number) => ({ index, embedding: [0.2 + index, 0.4, 0.6] }));
  const payload: any = { id: `local-${fixtureRequests.length}`, model: body.model, data };
  if (!unknownUsage) payload.usage = { prompt_tokens: input.length * 3, total_tokens: input.length * 3 };
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload));
});

const dataDir = mkdtempSync(path.join(tmpdir(), 'ivd-literature-index-'));
let restoreDataDir = '';
process.env.DATA_DIR = dataDir;
process.env.IVD_EMBEDDING_API_KEY = 'synthetic-only-key';
const { db } = await import('./db.ts');
const webPort = await freePort();
const embeddingPort = await freePort();
const baseUrl = `http://127.0.0.1:${webPort}`;
const embeddingBaseUrl = `http://127.0.0.1:${embeddingPort}/v1`;
const qdrantUrl = String(process.env.QDRANT_URL || '');
assert(qdrantUrl, '需传入隔离真实 Qdrant 地址；不接受内存替身');
assert((await fetch(`${qdrantUrl.replace(/\/$/, '')}/collections`)).ok, '验证真实 Qdrant HTTP endpoint');
const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, PORT: String(webPort), IVD_AI_API_KEY: '', IVD_EMBEDDING_API_KEY: 'synthetic-only-key',
  QDRANT_URL: qdrantUrl, QDRANT_API_KEY: '', ADMIN_NAME: '文献向量测试管理员', ADMIN_EMAIL: `literature-index-${Date.now()}@example.test`,
  ADMIN_PASSWORD: 'literature-index-admin-password-long' };
let app: ReturnType<typeof spawn> | undefined;
let appOutput = '';
let cookie = '';
const call = async (url: string, body?: any, method = 'GET', authCookie = cookie) => {
  const headers: Record<string, string> = {}; if (authCookie) headers.Cookie = authCookie;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + url, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, data, response };
};
async function waitForHealth() {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(baseUrl + '/api/health')).ok) return; } catch { /* startup */ } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Web app failed to start: ${appOutput}`);
}
const uploadText = async (title: string, content: string, metadata: Record<string, unknown> = {}) => {
  const form = new FormData(); form.set('records', JSON.stringify([{ title, authors: ['Synthetic Fixture'], year: 2026, abstract: content.slice(0, 200), ...metadata }]));
  form.append('files', new Blob([content], { type: 'text/plain' }), `${title}.txt`);
  const created = await call('/api/literature', form, 'POST');
  equal(created.status, 201, `上传合成文献 ${title}; response=${JSON.stringify(created.data)}`);
  return String(created.data.results[0].item.id);
};
const runWorkerOnce = () => run(['src/literature-worker.ts'], { ...env, IVD_LITERATURE_WORKER_ONCE: '1' });
const gateNextEmbedding = (marker: string) => {
  embeddingGateMatch = marker;
  let arrived!: () => void;
  let release!: () => void;
  const requestArrived = new Promise<void>(resolve => { arrived = resolve; });
  const responseRelease = new Promise<void>(resolve => { release = resolve; });
  embeddingGateArrived = arrived;
  embeddingGateRelease = release;
  embeddingGateReleased = responseRelease;
  return { requestArrived, release: () => embeddingGateRelease?.() };
};

try {
  embeddingServer.listen(embeddingPort, '127.0.0.1'); await once(embeddingServer, 'listening');
  await run(['src/cli.ts', 'admin-init'], env);
  app = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout?.on('data', value => appOutput += value); app.stderr?.on('data', value => appOutput += value);
  await waitForHealth();
  const adminLogin = await call('/api/auth/login', { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }, 'POST', '');
  equal(adminLogin.status, 200, '隔离管理员登录'); cookie = (adminLogin.response.headers.get('set-cookie') || '').split(';')[0];
  const member = await call('/api/users', { name: '合成只读成员', email: `literature-member-${Date.now()}@example.test`, role: 'RESEARCHER', password: 'literature-member-password-long' }, 'POST');
  equal(member.status, 201, '管理员建立隔离只读成员');
  const memberLogin = await call('/api/auth/login', { email: member.data.email, password: 'literature-member-password-long' }, 'POST', '');
  equal(memberLogin.status, 200, '隔离只读成员登录'); const memberCookie = (memberLogin.response.headers.get('set-cookie') || '').split(';')[0];
  const adminId = String(db.prepare('SELECT id FROM users WHERE email=?').get(String(env.ADMIN_EMAIL))?.id || '');
  const { searchLiterature } = await import('./literature/search.ts');

  const profileModel = `fixture-literature-${Date.now()}`;
  const config = { baseUrl: embeddingBaseUrl, model: profileModel, dimensions: 3, distance: 'Cosine', documentPrefix: '', queryPrefix: 'QUERY_NO_USAGE::',
    sendDimensions: false, autoIndex: false, batchSize: 1, maxInputChars: 4000, timeoutMs: 3000, taskTokenBudget: 1000, maxRequests: 100,
    queryTokenBudget: 1000, queryMaxRequests: 100 };
  const savedConfig = await call('/api/admin/literature/embedding-config', config, 'PATCH');
  equal(savedConfig.status, 200, '保存本地合成 Embedding profile');

  const itemId = await uploadText('Synthetic protein assay paper', 'This synthetic paper describes a protein assay, calibration series, and 12 replicate samples for an enzyme validation study. 中文结果：蛋白质检测，校准曲线，重复样本。 legacyfulltextmarker',
    { doi: '10.5555/ivd.synthetic.2026.01', keywords: ['蛋白定量', 'validation'], abstract: 'legacyuniquephrase only target' });
  await runWorkerOnce();
  const parsed = await call(`/api/literature/${itemId}`); equal(parsed.data.extraction?.status, 'parsed', '隔离 Worker 本地解析 TXT');
  const retrievalCases: Array<[string, boolean]> = [
    ['protein assay',true],['calibration series',true],['replicate samples',true],['enzyme validation',true],['validation study',true],
    ['protein',true],['calibration',true],['replicate',true],['enzyme',true],['Synthetic Fixture',true],['2026',true],
    ['Synthetic protein assay paper',true],['10.5555/ivd.synthetic.2026.01',true],['蛋白质检测',true],['校准曲线',true],
    ['重复样本',true],['蛋白定量',true],['中文结果',true],['unlikely astrocyte assay',false],['metabolomic zebrafish',false],
  ];
  const retrievalRows: string[] = ['query\texpect\tactual\ttop_hit'];
  for (const [query, expected] of retrievalCases) {
    const found = await call(`/api/literature/search?q=${encodeURIComponent(query)}&mode=keyword`);
    equal(found.status, 200, `固定检索集响应 ${query}`);
    const hit = found.data.results.some((row: any) => row.id === itemId);
    equal(hit, expected, `固定中英关键词检索 ${query}`);
    retrievalRows.push(`${query}\t${expected ? 'hit' : 'no_hit'}\t${hit ? 'hit' : 'no_hit'}\t${found.data.results[0]?.title || ''}`);
  }
  writeFileSync(path.resolve('work/literature-retrieval-eval-20261028.log'), `${retrievalRows.join('\n')}\n`, 'utf8');
  const indexQueued = await call(`/api/literature/${itemId}/index`, {}, 'POST'); equal(indexQueued.status, 202, `提交持久索引任务; response=${JSON.stringify(indexQueued.data)}`);
  const requestCountBefore = fixtureRequests.length;
  await runWorkerOnce();
  const indexed = await call(`/api/literature/${itemId}`);
  const generation = indexed.data.indexes.find((row: any) => row.id === indexQueued.data.generationId);
  equal(generation?.status, 'ready', '所有片段向量写入真实 Qdrant 后发布 generation');
  const indexJob = indexed.data.jobs.find((job: any) => job.id === indexQueued.data.jobId);
  equal(indexJob.status, 'completed', '索引任务完成并保存 usage');
  assert(indexJob.usage_request_count >= 1 && indexJob.usage_tokens > 0 && indexJob.usage_unknown_count === 0, '任务累计请求和真实 fixture usage 持久化');
  const profile = db.prepare('SELECT * FROM literature_embedding_profiles WHERE active=1').get() as any;
  const { qdrantClient } = await import('./literature/vector.ts');
  const collection = String(generation.collection_name);
  assert((await qdrantClient().collectionExists(collection)).exists, '真实 Qdrant 中创建应用命名空间 collection');
  const points = await qdrantClient().scroll(collection, { limit: 100, with_payload: true, with_vector: false,
    filter: { must: [{ key: 'generation_id', match: { value: generation.id } }] } } as any) as any;
  assert(points.points.length === Number(generation.indexed_count) && points.points.length > 0, '真实 Qdrant 存在当前代、带 source payload 的点');
  assert(fixtureRequests.slice(requestCountBefore).every(item => item.auth === 'Bearer synthetic-only-key'), 'Embedding HTTP fixture 收到进程内合成密钥');
  const afterIndexRequests = fixtureRequests.length;

  const rebuild = await call(`/api/literature/${itemId}/index`, {}, 'POST'); equal(rebuild.status, 202, '同 profile 新代索引排队'); await runWorkerOnce();
  equal(fixtureRequests.length, afterIndexRequests, '新 generation 从带 SHA 的 embedding cache 恢复，不重复外呼');
  const cachedDetail = await call(`/api/literature/${itemId}`);
  const cachedGeneration = cachedDetail.data.indexes.find((row: any) => row.id === rebuild.data.generationId);
  equal(cachedGeneration?.status, 'ready', '缓存恢复仍可完整发布');

  const oldGeneration = cachedGeneration;
  const { ensureLiteratureCollection, upsertLiteraturePoints, deterministicPointId } = await import('./literature/vector.ts');
  const staleChunk = db.prepare(`SELECT c.id,c.content_sha256 FROM literature_chunks c WHERE c.item_id=? ORDER BY c.sequence_no LIMIT 1`).get(itemId) as any;
  await qdrantClient().deleteCollection(collection);
  await ensureLiteratureCollection(collection, 3, 'Cosine');
  await upsertLiteraturePoints(collection, 3, 'Cosine', [{
    id: deterministicPointId(String(profile.id), String(staleChunk.id), String(oldGeneration.id)), vector: [0.2, 0.4, 0.6],
    payload: { item_id: itemId, version_id: cachedDetail.data.currentVersion.id, chunk_id: staleChunk.id, profile_id: profile.id,
      generation_id: oldGeneration.id, content_sha256: staleChunk.content_sha256, source_extent: 'metadata' },
  }]);
  const offlineJob = await call(`/api/literature/${itemId}/index`, {}, 'POST'); equal(offlineJob.status, 202, '提交完整缓存的空向量库重建任务');
  const beforeOfflineRequests = fixtureRequests.length;
  await run(['src/literature-worker.ts'], { ...env, IVD_EMBEDDING_API_KEY: '', IVD_LITERATURE_WORKER_ONCE: '1' });
  const offlineDetail = await call(`/api/literature/${itemId}`);
  const offlineRow = offlineDetail.data.jobs.find((job: any) => job.id === offlineJob.data.jobId);
  equal(offlineRow.status, 'completed', '清空Qdrant且Embeddings密钥为空时，从完整SQLite向量缓存离线重建');
  equal(fixtureRequests.length, beforeOfflineRequests, '离线缓存恢复没有发出Embedding请求');
  const offlineGeneration = offlineDetail.data.indexes.find((row: any) => row.id === offlineJob.data.generationId);
  equal(offlineGeneration.status, 'ready', '空Qdrant恢复后整代发布');
  const offlinePoints = await qdrantClient().scroll(collection, { limit: 200, with_payload: true, with_vector: false } as any) as any;
  assert(offlinePoints.points.some((point: any) => point.payload?.generation_id === offlineGeneration.id), '空Qdrant恢复写入新的当前generation');
  assert(offlinePoints.points.some((point: any) => point.payload?.generation_id === oldGeneration.id), '隔离夹具保留旧代污染点以验证检索按当前 generation 过滤');

  const cachedRow = db.prepare(`SELECT * FROM literature_embedding_cache WHERE profile_id=? AND chunk_id IN
    (SELECT id FROM literature_chunks WHERE item_id=?) ORDER BY rowid LIMIT 1`).get(profile.id, itemId) as any;
  assert(cachedRow, '准备缺失缓存隔离夹具');
  db.prepare('DELETE FROM literature_embedding_cache WHERE id=?').run(cachedRow.id);
  const partialOfflineJob = await call(`/api/literature/${itemId}/index`, {}, 'POST'); equal(partialOfflineJob.status, 202, '提交包含缺失缓存的重建任务');
  const beforePartialRequests = fixtureRequests.length;
  await run(['src/literature-worker.ts'], { ...env, IVD_EMBEDDING_API_KEY: '', IVD_LITERATURE_WORKER_ONCE: '1' });
  const partialRow = db.prepare('SELECT status,attempt_count,error_code FROM literature_jobs WHERE id=?').get(partialOfflineJob.data.jobId) as any;
  equal(partialRow.status, 'waiting_configuration', '缺少缓存且无密钥时显示等待配置');
  equal(partialRow.attempt_count, 0, '缺缓存等待不会消耗任务尝试次数');
  equal(fixtureRequests.length, beforePartialRequests, '缺缓存等待不外呼Embedding');
  db.prepare(`INSERT INTO literature_embedding_cache(id,chunk_id,profile_id,input_sha256,dimensions,vector_blob,vector_sha256,usage_tokens,usage_status,response_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(cachedRow.id,cachedRow.chunk_id,cachedRow.profile_id,cachedRow.input_sha256,cachedRow.dimensions,
      cachedRow.vector_blob,cachedRow.vector_sha256,cachedRow.usage_tokens,cachedRow.usage_status,cachedRow.response_id);
  await run(['src/literature-worker.ts'], { ...env, IVD_EMBEDDING_API_KEY: '', IVD_LITERATURE_WORKER_ONCE: '1' });
  equal((db.prepare('SELECT status FROM literature_jobs WHERE id=?').get(partialOfflineJob.data.jobId) as any).status, 'completed', '补齐有效缓存后无需密钥即可恢复等待任务');
  equal(fixtureRequests.length, beforePartialRequests, '恢复等待任务仍没有Embedding外呼');

  const waitForParsed = async (raceItemId: string) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const detail = await call(`/api/literature/${raceItemId}`);
      if (detail.data.extraction) return detail.data;
      await runWorkerOnce();
    }
    throw new Error(`Race fixture ${raceItemId} was not parsed by the local worker`);
  };
  const startGatedIndex = async (title: string, marker: string) => {
    const raceItemId = await uploadText(title, `${marker} synthetic race marker with a protein assay validation record.`);
    await waitForParsed(raceItemId);
    const queued = await call(`/api/literature/${raceItemId}/index`, {}, 'POST');
    equal(queued.status, 202, `提交竞态夹具 ${title} 的索引任务`);
    const gate = gateNextEmbedding(marker);
    const workerRun = runWorkerOnce();
    await Promise.race([gate.requestArrived, new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`Embedding request gate not reached: ${marker}`)), 10_000))]);
    return { raceItemId, jobId: String(queued.data.jobId), gate, workerRun };
  };

  const replacementRace = await startGatedIndex('Synthetic replacement race', 'RACE_GATE_REPLACE_2026');
  const replacementBefore = await call(`/api/literature/${replacementRace.raceItemId}`);
  const replacementForm = new FormData();
  replacementForm.set('expectedRevision', String(replacementBefore.data.revision)); replacementForm.set('changeNote', '替换期间竞态隔离夹具');
  replacementForm.append('file', new Blob(['replacement source after indexing request'], { type: 'text/plain' }), 'replacement-race-v2.txt');
  const replacementResult = await call(`/api/literature/${replacementRace.raceItemId}/versions`, replacementForm, 'POST');
  equal(replacementResult.status, 201, 'Embedding 在途期间替换来源文件成功');
  replacementRace.gate.release(); await replacementRace.workerRun;
  const replacementJob = db.prepare('SELECT status FROM literature_jobs WHERE id=?').get(replacementRace.jobId) as any;
  equal(replacementJob.status, 'superseded', '替换來源会立即fence在途索引worker');
  equal(Number((db.prepare("SELECT COUNT(*) AS n FROM literature_index_generations WHERE item_id=? AND status='ready'").get(replacementRace.raceItemId) as any).n), 0,
    '替换后旧来源竞态不发布可检索 generation');
  await waitForParsed(replacementRace.raceItemId);

  const deletionRace = await startGatedIndex('Synthetic deletion race', 'RACE_GATE_DELETE_2026');
  const deletionDetail = await call(`/api/literature/${deletionRace.raceItemId}`);
  const deletionEvidence = await searchLiterature('RACE_GATE_DELETE_2026', { mode: 'keyword', actor: { id: adminId, role: 'ADMIN' },
    scope: { itemIds: [deletionRace.raceItemId] }, persistEvidence: true });
  assert(deletionEvidence.results[0]?.evidenceRefId, '删除竞态预置当前文献证据 ref');
  const deletedDuringEmbedding = await call(`/api/literature/${deletionRace.raceItemId}`, { expectedRevision: deletionDetail.data.revision }, 'DELETE');
  equal(deletedDuringEmbedding.status, 200, 'Embedding 在途期间软删除文献');
  deletionRace.gate.release(); await deletionRace.workerRun;
  equal((db.prepare('SELECT status FROM literature_jobs WHERE id=?').get(deletionRace.jobId) as any).status, 'cancelled', '删除会撤销在途索引租约');
  equal(Number((db.prepare("SELECT COUNT(*) AS n FROM literature_index_generations WHERE item_id=? AND status='ready'").get(deletionRace.raceItemId) as any).n), 0,
    '已删除来源的竞态结果不会发布');
  const { readCurrentLiteratureEvidence } = await import('./literature/search.ts');
  equal(readCurrentLiteratureEvidence(String(deletionEvidence.results[0].evidenceRefId)), undefined, '删除后竞态夹具旧证据立即失效');

  const concurrentJob = await call(`/api/literature/${itemId}/index`, {}, 'POST'); equal(concurrentJob.status, 202, '提交双 worker 抢领竞态索引任务');
  await Promise.all([runWorkerOnce(), runWorkerOnce()]);
  const concurrentState = db.prepare('SELECT status,attempt_count FROM literature_jobs WHERE id=?').get(concurrentJob.data.jobId) as any;
  equal(concurrentState.status, 'completed', '两个独立 worker 并发时索引任务最终完成');
  equal(concurrentState.attempt_count, 1, 'SQLite 租约保证并发 worker 仅一方领取该任务');
  const restartJob = await call(`/api/literature/${itemId}/index`, {}, 'POST'); equal(restartJob.status, 202, '准备 worker 重启租约恢复夹具');
  db.prepare("UPDATE literature_jobs SET status='embedding',lease_owner='fixture-dead-worker',lease_until_ms=0,attempt_count=1,usage_pending_count=0 WHERE id=?")
    .run(restartJob.data.jobId);
  db.prepare("UPDATE literature_index_generations SET status='building' WHERE id=?").run(restartJob.data.generationId);
  await runWorkerOnce();
  const restarted = db.prepare('SELECT status,attempt_count FROM literature_jobs WHERE id=?').get(restartJob.data.jobId) as any;
  equal(restarted.status, 'completed', '过期租约在 worker 重启后重新完成索引');
  equal(restarted.attempt_count, 2, 'worker 重启后重新领取次数准确累计');
  assert(db.prepare("SELECT 1 FROM literature_job_events WHERE job_id=? AND event_type='requeued'").get(restartJob.data.jobId), 'worker 重启租约回队列留有持久事件');

  const keywordOnlyId = await uploadText('Protein assay keyword-only decoy', 'Unrelated local fixture without a published vector index.');
  await runWorkerOnce();
  const { createLiteratureRecord } = await import('./literature/repository.ts');
  db.prepare("UPDATE literature_items SET updated_at='1900-01-01',created_at='1900-01-01' WHERE id=?").run(itemId);
  for (let index = 0; index < 250; index++) createLiteratureRecord({ id: adminId, role: 'ADMIN' },
    { title: `New scope filler ${index}`, abstract: 'Unrelated filler text.' });
  const oldKeywordSearch = await searchLiterature('legacyuniquephrase', { mode: 'keyword', scope: { allowAll: true }, actor: { id: adminId, role: 'ADMIN' } });
  assert(oldKeywordSearch.results.some((row: any) => row.literatureId === itemId), `251+资料的全库关键词搜索包含更新时间最旧的目标资料; target=${JSON.stringify(db.prepare('SELECT id,revision,abstract FROM literature_items WHERE id=?').get(itemId))}; chunks=${JSON.stringify(db.prepare('SELECT id,metadata_revision,content_text FROM literature_chunks WHERE item_id=?').all(itemId))}; results=${JSON.stringify(oldKeywordSearch.results.map((row: any) => ({ id: row.id, literatureId: row.literatureId, excerpt: row.excerpt })))}`);
  const oldFullTextSearch = await searchLiterature('legacyfulltextmarker', { mode: 'keyword', scope: { itemIds: [itemId] }, actor: { id: adminId, role: 'ADMIN' } });
  assert(oldFullTextSearch.results.some((row: any) => row.literatureId === itemId), '显式选中的旧资料正文仍可搜索');
  const oldMetadataSearch = await searchLiterature('legacyuniquephrase', { mode: 'keyword', scope: { itemIds: [itemId] }, actor: { id: adminId, role: 'ADMIN' } });
  assert(oldMetadataSearch.results.some((row: any) => row.literatureId === itemId), '显式选中的旧资料摘要元数据仍可搜索');
  const oldCollection = await call('/api/literature/collections', { name: 'Old target collection', description: 'scope regression' }, 'POST');
  db.prepare('INSERT INTO literature_item_collections(item_id,collection_id,added_by) VALUES (?,?,?)').run(itemId, oldCollection.data.id, adminId);
  const oldCollectionSearch = await searchLiterature('legacyuniquephrase', { mode: 'keyword', scope: { collectionIds: [String(oldCollection.data.id)] }, actor: { id: adminId, role: 'ADMIN' } });
  assert(oldCollectionSearch.results.some((row: any) => row.literatureId === itemId), '旧文献集合范围不会被展示列表上限裁掉');

  provideQueryUsage = true;
  const oldSelectedSemantic = await searchLiterature('protein assay', { mode: 'semantic', scope: { itemIds: [itemId] }, actor: { id: adminId, role: 'ADMIN' } });
  assert(oldSelectedSemantic.results.some((row: any) => row.literatureId === itemId), '超过250份资料后显式选中的旧文献仍可语义检索');
  const oldCollectionSemantic = await searchLiterature('protein assay', { mode: 'semantic', scope: { collectionIds: [String(oldCollection.data.id)] }, actor: { id: adminId, role: 'ADMIN' } });
  assert(oldCollectionSemantic.results.some((row: any) => row.literatureId === itemId), '超过250份资料后旧文献集合范围仍可语义检索');
  const semanticBefore = fixtureRequests.length;
  const semantic = await call('/api/literature/search?q=' + encodeURIComponent('protein assay') + '&mode=semantic');
  equal(semantic.status, 200, '已配置 Embedding 和真实 Qdrant 的语义路径成功');
  equal(semantic.data.mode, 'semantic', '语义模式只返回语义结果并显示成功模式');
  assert(semantic.data.results.some((row: any) => row.id === itemId && row.literatureId === itemId && row.itemId === itemId), '语义结果的 item ID 一致且可定位文献');
  assert(semantic.data.results.every((row: any) => row.id !== keywordOnlyId), '纯语义检索不混入仅关键词命中的文献');
  assert(semantic.data.results.every((row: any) => typeof row.chunkId === 'string' && row.chunkId.startsWith('lch_')), '检索命中独立返回 chunkId');
  const liveSemantic = await searchLiterature('protein assay', { mode: 'semantic', actor: { id: adminId, role: 'ADMIN' } });
  const latestReadyGeneration = db.prepare("SELECT id FROM literature_index_generations WHERE item_id=? AND status='ready' ORDER BY generation_no DESC LIMIT 1").get(itemId) as any;
  assert(latestReadyGeneration?.id && liveSemantic.results.length > 0
      && liveSemantic.results.every((row: any) => row.live_generation === latestReadyGeneration.id),
    `Qdrant 中残留的旧 generation 点不进入当前语义结果; mode=${liveSemantic.mode}; fallback=${liveSemantic.fallbackReason}; latest=${latestReadyGeneration?.id}; results=${JSON.stringify(liveSemantic.results.map((row: any) => ({ id: row.id, generation: row.live_generation, chunk: row.chunkId, retrieval: row.retrieval })))}`);
  equal(fixtureRequests.length, semanticBefore + 2, 'API 与隔离检索调用各自通过本地HTTP执行一次语义Embedding');
  const usageKnown = db.prepare('SELECT request_count,unknown_count,usage_status FROM literature_query_usage WHERE profile_id=?').get(profile.id) as any;
  equal(usageKnown.request_count, 4, '全库、显式文献、集合以及本地检索的成功语义请求进入持久预算'); equal(usageKnown.usage_status, 'known', '合成provider usage按已知用量累计');

  const semanticItem = await uploadText('Synthetic long multi-chunk semantic item', 'protein assay semantic marker '.repeat(180));
  await runWorkerOnce();
  const longIndex = await call(`/api/literature/${semanticItem}/index`, {}, 'POST'); equal(longIndex.status, 202, '多片段测试文献排队索引'); await runWorkerOnce();
  provideQueryUsage = true;
  const perItemSearch = await call('/api/literature/search?q=' + encodeURIComponent('protein assay semantic marker') + '&mode=semantic');
  equal(perItemSearch.status, 200, '多片段语义查询成功');
  assert(perItemSearch.data.results.filter((row: any) => row.literatureId === semanticItem).length <= 3, '单份文献最多返回三个语义片段');
  const semanticLibraryList = await call('/api/literature?q=' + encodeURIComponent('protein assay semantic marker') + '&mode=semantic');
  equal(semanticLibraryList.status, 200, '文献目录语义检索列表成功');
  const semanticLibraryRows = semanticLibraryList.data.rows.filter((row: any) => row.literatureId === semanticItem);
  equal(semanticLibraryRows.length, 1, '目录把多片段语义命中折叠为一个文献条目');
  equal(semanticLibraryRows[0]?.id, semanticItem, '目录文献条目id保持literature id，点击后能定位原文');
  assert(semanticLibraryRows[0]?.searchExcerpt && semanticLibraryRows[0]?.searchLocator, '去重后的目录条目仍保留最高排名片段和页码定位');

  db.prepare('DELETE FROM literature_query_usage').run();
  provideQueryUsage = false;
  const semanticUnknownBefore = fixtureRequests.length;
  const semanticUnknown = await call('/api/literature/search?q=' + encodeURIComponent('protein assay validation') + '&mode=hybrid');
  equal(semanticUnknown.status, 200, '无usage路径安全返回关键词降级');
  equal(semanticUnknown.data.mode, 'keyword', '缺失 query usage 时明确退回关键词');
  assert(String(semanticUnknown.data.fallbackReason).includes('用量'), 'query usage unknown 显示清楚的降级说明');
  equal(fixtureRequests.length, semanticUnknownBefore + 1, '本地 HTTP query embedding 只请求一次');
  const usageAfterUnknown = db.prepare('SELECT request_count,unknown_count,usage_status FROM literature_query_usage WHERE profile_id=?').get(profile.id) as any;
  equal(usageAfterUnknown.request_count, 1, '查询请求计入每日预算'); equal(usageAfterUnknown.unknown_count, 1, '缺失 usage 明确计未知');
  const beforeUnknownAgain = fixtureRequests.length;
  const unknownAgain = await call('/api/literature/search?q=' + encodeURIComponent('enzyme validation') + '&mode=semantic');
  equal(unknownAgain.status, 200, 'unknown usage 之后安全降级'); equal(fixtureRequests.length, beforeUnknownAgain, 'query 用量未知阻止同用户当日后续外呼');

  const { buildAssistantTools } = await import('./ai/tools.ts');
  const session = await call('/api/ai/sessions', { contextType: 'knowledge_base', contextIds: [], literatureScope: { type: 'items', literatureIds: [itemId] } }, 'POST', memberCookie);
  equal(session.status, 201, '成员建立显式单文献助手会话');
  const memberContext = { jobId: 'fixture-ai-job', contextType: 'knowledge_base' as const, contextIds: [], literatureScope: { itemIds: [itemId] },
    reportScope: [], actor: { id: String(member.data.id), role: 'RESEARCHER' } };
  const tools = buildAssistantTools(memberContext);
  const searchTool = tools.find((tool: any) => tool.name === 'search_literature')!;
  const toolResult = await searchTool.execute('search-call', { query: 'protein assay', mode: 'keyword', limit: 3 }, new AbortController().signal, () => {});
  const searchPayload = JSON.parse(toolResult.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join(''));
  assert(searchPayload.results.length > 0 && searchPayload.results.every((row: any) => row.literatureId === itemId && row.evidenceRefId), 'Agent 工具只返回所选文献的带 evidence ref 命中');
  const refId = String(searchPayload.results[0].evidenceRefId);
  const readTool = tools.find((tool: any) => tool.name === 'read_literature_evidence')!;
  const readResult = await readTool.execute('read-call', { evidenceRefId: refId }, new AbortController().signal, () => {});
  assert(JSON.parse(readResult.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('')).text.includes('protein assay'), 'Agent 可读取当前片段和原文内容');
  const createOutOfScope = await import('./literature/search.ts');
  const secondItemId = await uploadText('Synthetic unrelated paper', 'Synthetic unrelated calibration dataset and sample assay measurements.');
  await runWorkerOnce();
  const secondMetadata = await call(`/api/literature/${secondItemId}`);
  const scopedEvidence = await createOutOfScope.searchLiterature('unrelated calibration', { mode: 'keyword', actor: { id: String(member.data.id), role: 'RESEARCHER' },
    scope: { itemIds: [secondItemId] }, persistEvidence: true });
  assert(scopedEvidence.results[0]?.evidenceRefId, '建立范围外证据仅供拒绝性权限断言');
  let rejectedOutOfScope = false;
  try { await readTool.execute('outside-read', { evidenceRefId: scopedEvidence.results[0].evidenceRefId }, new AbortController().signal, () => {}); }
  catch { rejectedOutOfScope = true; }
  assert(rejectedOutOfScope, '助手读取工具拒绝当前会话范围外的有效文献引用');
  const emptyScopeTools = buildAssistantTools({ ...memberContext, literatureScope: { itemIds: [] } });
  const emptySearch = await emptyScopeTools.find((tool: any) => tool.name === 'search_literature')!.execute('empty', { query: 'protein assay' }, new AbortController().signal, () => {});
  equal(JSON.parse(emptySearch.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('')).results.length, 0, '空文献范围不扩展为全库');

  const staleMetadataRef = String(scopedEvidence.results[0].evidenceRefId);
  const secondRow = secondMetadata.data;
  const newMetadata = await call(`/api/literature/${secondItemId}`, { expectedRevision: secondRow.revision, title: 'Synthetic unrelated paper revised' }, 'PATCH');
  equal(newMetadata.status, 200, '修改文献信息后建立新 metadata revision');
  equal((await call(`/api/literature/evidence/${staleMetadataRef}`)).status, 404, '旧 metadata 引用随版本变化立即失效');

  const noUsageModel = `${profileModel}-no-usage`;
  const unknownConfig = { ...config, model: noUsageModel, documentPrefix: 'DOC_NO_USAGE::', queryPrefix: '', autoIndex: false };
  const profileSaved = await call('/api/admin/literature/embedding-config', unknownConfig, 'PATCH'); equal(profileSaved.status, 200, '切换到隔离的无 usage 文档测试 profile');
  const unknownItemId = await uploadText('Synthetic unknown usage paper', 'This is an isolated unknown-usage document indexing fixture.');
  await runWorkerOnce();
  const unknownIndex = await call(`/api/literature/${unknownItemId}/index`, {}, 'POST'); equal(unknownIndex.status, 202, '提交待测 unknown usage 文献');
  const beforeUnknownDocRequest = fixtureRequests.length; await runWorkerOnce();
  const unknownItem = await call(`/api/literature/${unknownItemId}`);
  const unknownJob = unknownItem.data.jobs.find((job: any) => job.id === unknownIndex.data.jobId);
  equal(unknownJob.status, 'partial', '缺失 provider 用量任务保持 partial');
  equal(unknownJob.usage_unknown_count, 1, '索引缺失 usage 计入未知请求数');
  equal(fixtureRequests.length, beforeUnknownDocRequest + 1, '索引 unknown usage 后仅发生一次在线请求');
  equal((await call(`/api/literature/jobs/${unknownIndex.data.jobId}/retry`, {}, 'POST')).status, 409, 'unknown usage 禁止原任务重试');
  const newAttempt = await call(`/api/literature/${unknownItemId}/index`, {}, 'POST'); equal(newAttempt.status, 409, '同一文献/profile 不能通过新任务绕过 unknown usage');

  const emptyScope = await call('/api/ai/sessions', { contextType: 'knowledge_base', contextIds: [], literatureScope: { type: 'items', literatureIds: [] } }, 'POST', memberCookie);
  equal(emptyScope.status, 201, '允许显式空范围的会话');
  const emptyScopeRead = await call(`/api/ai/sessions/${emptyScope.data.id}`, undefined, 'GET', memberCookie);
  equal(emptyScopeRead.data.literatureScopeType, 'items', '会话范围持久保存');

  // Exercise the full application backup/restore path, then rebuild an empty Qdrant
  // collection from the restored SHA-verified cache while the online key is absent.
  equal((await call('/api/admin/literature/embedding-config', config, 'PATCH')).status, 200, '切回已知usage的合成Embedding profile，为全量备份离线重建准备完整cache');
  const restoredCacheItemId = await uploadText('Synthetic full-backup offline rebuild',
    'A synthetic assay report for full backup restore cache replay and offline Qdrant rebuild.');
  await runWorkerOnce();
  const restoredCacheIndex = await call(`/api/literature/${restoredCacheItemId}/index`, {}, 'POST');
  equal(restoredCacheIndex.status, 202, '全量备份夹具文献索引排队');
  await runWorkerOnce();
  const restoredCacheDetail = await call(`/api/literature/${restoredCacheItemId}`);
  const restoredReadyGeneration = restoredCacheDetail.data.indexes.find((row: any) => row.id === restoredCacheIndex.data.generationId);
  equal(restoredReadyGeneration?.status, 'ready', '备份夹具先完成在线缓存与真实Qdrant索引');
  const replayQueue = await call(`/api/literature/${restoredCacheItemId}/index`, {}, 'POST');
  equal(replayQueue.status, 202, '备份快照记录待重放的索引任务');
  const backupCreated = await call('/api/admin/backups', {}, 'POST');
  equal(backupCreated.status, 200, `通过应用API创建完整数据库与附件备份; response=${JSON.stringify(backupCreated.data)}`);
  restoreDataDir = mkdtempSync(path.join(tmpdir(), 'ivd-literature-restored-'));
  const { restoreBackup } = await import('./restore-core.ts');
  await restoreBackup(path.join(dataDir, 'backups', String(backupCreated.data.filename)), restoreDataDir);
  const restoredGeneration = db.prepare('SELECT collection_name FROM literature_index_generations WHERE id=?').get(replayQueue.data.generationId) as any;
  assert(restoredGeneration?.collection_name, '完整备份保留索引generation和collection清单');
  await qdrantClient().deleteCollection(String(restoredGeneration.collection_name));
  assert(!(await qdrantClient().collectionExists(String(restoredGeneration.collection_name))).exists, '恢复前确认为空Qdrant collection');
  const beforeRestoredOfflineRequests = fixtureRequests.length;
  await run(['src/literature-worker.ts'], { ...env, DATA_DIR: restoreDataDir, IVD_EMBEDDING_API_KEY: '', IVD_LITERATURE_WORKER_ONCE: '1' });
  const restoredDb = new DatabaseSync(path.join(restoreDataDir, 'ivd.sqlite'));
  try {
    const restoredJob = restoredDb.prepare('SELECT status,usage_status FROM literature_jobs WHERE id=?').get(replayQueue.data.jobId) as any;
    equal(restoredJob?.status, 'completed', '完整备份恢复到新DATA_DIR和空Qdrant后，清空Embedding密钥仍离线完成任务');
    const restoredGenerationRow = restoredDb.prepare('SELECT status,indexed_count,chunk_count,collection_name FROM literature_index_generations WHERE id=?').get(replayQueue.data.generationId) as any;
    equal(restoredGenerationRow?.status, 'ready', '完整备份离线重建后generation ready');
    equal(Number(restoredGenerationRow?.indexed_count), Number(restoredGenerationRow?.chunk_count), '备份缓存完整覆盖所有文献片段');
    const restoredCacheCount = Number(restoredDb.prepare(`SELECT COUNT(*) AS n FROM literature_embedding_cache
      WHERE profile_id=(SELECT profile_id FROM literature_index_generations WHERE id=?)
      AND chunk_id IN (SELECT id FROM literature_chunks WHERE item_id=?)`).get(replayQueue.data.generationId, restoredCacheItemId)?.n || 0);
    assert(restoredCacheCount >= Number(restoredGenerationRow?.chunk_count), 'SQLite备份中的全部chunk向量缓存可用于重建');
    const restoredQdrantPoints = await qdrantClient().scroll(String(restoredGenerationRow.collection_name), { limit: 200, with_payload: true, with_vector: false,
      filter: { must: [{ key: 'generation_id', match: { value: replayQueue.data.generationId } }] } } as any) as any;
    equal(restoredQdrantPoints.points.length, Number(restoredGenerationRow.indexed_count), 'Qdrant空collection由恢复的缓存重新写入当前generation全部点');
  } finally { restoredDb.close(); }
  equal(fixtureRequests.length, beforeRestoredOfflineRequests, '新恢复实例没有在线密钥且未向Embedding服务发请求');
  assert(fixtureRequests.every(item => item.auth === 'Bearer synthetic-only-key' && item.model.startsWith('fixture-literature-')), '全部 Embedding HTTP 请求仅到本地合成 fixture');
  console.log(`LITERATURE INDEX INTEGRATION PASS: isolated DATA_DIR=${dataDir}; restored DATA_DIR=${restoreDataDir}; real Qdrant=${qdrantUrl}; local embedding requests=${fixtureRequests.length}; ${retrievalCases.length} fixed bilingual keyword queries recorded in work/literature-retrieval-eval-20261028.log; semantic IDs/mode/ranking, scope >250, cache-only rebuild, complete backup restore to empty Qdrant, usage accounting/unknown stop, current evidence and session scope verified.`);
  for (const row of db.prepare('SELECT DISTINCT collection_name FROM literature_index_generations').all() as any[]) {
    try { await (await import('./literature/vector.ts')).qdrantClient().deleteCollection(String(row.collection_name)); } catch { /* test-owned namespace cleanup */ }
  }
} finally {
  app?.kill('SIGTERM');
  if (app) await once(app, 'exit').catch(() => {});
  const closed = once(embeddingServer, 'close'); embeddingServer.close(); embeddingServer.closeAllConnections(); await closed;
  for (const row of db.prepare('SELECT DISTINCT collection_name FROM literature_index_generations').all() as any[]) {
    try { await (await import('./literature/vector.ts')).qdrantClient().deleteCollection(String(row.collection_name)); } catch { /* test-owned namespace cleanup */ }
  }
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (restoreDataDir) rmSync(restoreDataDir, { recursive: true, force: true });
}
import './test-isolation.mjs';
