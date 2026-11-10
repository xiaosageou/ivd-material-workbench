import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`REPORT KNOWLEDGE FAIL: ${message}`); };
const equal = (actual: unknown, expected: unknown, message: string) => assert(actual === expected, `${message} (actual=${actual}, expected=${expected})`);
const json = (res: any, value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: value, status: 'ok', time: 0 })); };
const readBody = async (req: any) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
};
async function listen(server: any) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return Number(server.address().port);
}
async function close(server: any) { await new Promise<void>(resolve => server.close(() => resolve())); }

const pointStore = new Map<string, any>();
const collections = new Set<string>();
const collectionDimensions = new Map<string, number>();
let queryObservationId = '';
let deleteRequests = 0;
let holdNextUpsert = false;
let upsertStarted: (() => void) | undefined;
let releaseHeldUpsert: (() => void) | undefined;
const qdrantServer = createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: 'Qdrant', version: '1.20.0' }));
  }
  const existsMatch = pathname.match(/^\/collections\/([^/]+)\/exists$/);
  const collectionMatch = pathname.match(/^\/collections\/([^/]+)$/);
  const pointsMatch = pathname.match(/^\/collections\/([^/]+)\/points(?:\/([^/]+))?$/);
  if (existsMatch && req.method === 'GET') return json(res, { exists: collections.has(existsMatch[1]) });
  if (collectionMatch && req.method === 'GET') {
    const name = collectionMatch[1];
    if (!collections.has(name)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: { error: 'not found' } })); }
    return json(res, { config: { params: { vectors: { size: collectionDimensions.get(name), distance: 'Cosine' } } } });
  }
  if (collectionMatch && req.method === 'PUT') {
    const body = await readBody(req); collections.add(collectionMatch[1]); collectionDimensions.set(collectionMatch[1], Number(body.vectors?.size || 3));
    return json(res, true);
  }
  if (pointsMatch && pointsMatch[2] === undefined && req.method === 'POST') {
    const body = await readBody(req); const rows = (body.ids || []).map((id: string) => pointStore.get(String(id))).filter(Boolean);
    return json(res, rows.map((point: any) => ({ id: point.id, payload: point.payload })));
  }
  if (pointsMatch && pointsMatch[2] === 'query' && req.method === 'POST') {
    const body = await readBody(req); const scopes = body.filter?.should || [];
    const rows = [...pointStore.values()].filter(point => scopes.some((scope: any) => {
      const must = scope.must || [];
      return must.every((filter: any) => {
        const expected = filter.match?.value;
        return point.payload?.[filter.key] === expected;
      });
    }));
    const selected = (queryObservationId && rows.find(point => point.payload?.observation_id === queryObservationId)) || rows[0];
    return json(res, { points: selected ? [{ id: selected.id, score: 0.91, payload: selected.payload }] : [] });
  }
  if (pointsMatch && pointsMatch[2] === 'delete' && req.method === 'POST') {
    deleteRequests++;
    const body = await readBody(req); const filter = body.filter || {};
    const reportId = filter.must?.find((item: any) => item.key === 'report_id')?.match?.value;
    const excluded = filter.must_not?.find((item: any) => item.key === 'knowledge_fingerprint')?.match?.value;
    for (const [id, point] of pointStore) if (point.payload?.report_id === reportId && point.payload?.knowledge_fingerprint !== excluded) pointStore.delete(id);
    return json(res, { operation_id: 1, status: 'completed' });
  }
  if (pointsMatch && !pointsMatch[2] && req.method === 'PUT') {
    const body = await readBody(req);
    for (const point of body.points || []) pointStore.set(String(point.id), { id: String(point.id), payload: point.payload || {}, vector: point.vector });
    if (holdNextUpsert) {
      holdNextUpsert = false;
      upsertStarted?.();
      await new Promise<void>(resolve => { releaseHeldUpsert = resolve; });
    }
    return json(res, { operation_id: 1, status: 'completed' });
  }
  if (pathname === '/collections' && req.method === 'GET') return json(res, { collections: [] });
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: true, status: 'ok', time: 0 }));
});

let embeddingRequests = 0;
const sentText: string[] = [];
let holdNextEmbedding = false;
let embeddingStarted: (() => void) | undefined;
let releaseHeldEmbedding: (() => void) | undefined;
const embeddingServer = createServer(async (req, res) => {
  if (req.method !== 'POST' || new URL(req.url || '/', 'http://127.0.0.1').pathname !== '/v1/embeddings') {
    res.writeHead(404); return res.end();
  }
  const body = await readBody(req); const inputs = Array.isArray(body.input) ? body.input : [body.input];
  embeddingRequests++;
  sentText.push(...inputs.map((value: unknown) => String(value)));
  if (holdNextEmbedding) {
    holdNextEmbedding = false;
    embeddingStarted?.();
    await new Promise<void>(resolve => { releaseHeldEmbedding = resolve; });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: `fixture-embedding-${embeddingRequests}`, model: body.model,
    data: inputs.map((_value: unknown, index: number) => ({ index, embedding: [1, 0, 0] })),
    usage: { prompt_tokens: Math.max(1, inputs.length), total_tokens: Math.max(2, inputs.length * 2) } }));
});

const qdrantPort = await listen(qdrantServer);
const embeddingPort = await listen(embeddingServer);
process.env.IVD_EMBEDDING_API_KEY = 'synthetic-report-knowledge-key';
process.env.QDRANT_URL = `http://127.0.0.1:${qdrantPort}`;

try {
  const { db, id, transaction } = await import('./db.ts');
  const { saveLiteratureEmbeddingConfig } = await import('./literature/embedding-config.ts');
  const { writeJobFromManifest, currentReportManifest } = await import('./ai/jobs.ts');
  const { enqueueReportKnowledgeIndex, enqueueAllCurrentReportKnowledge, processReportKnowledgeIndexOnce,
    reconcileReportKnowledgeIndexAfterRestore, reportKnowledgeExternalizationEnabled, retryReportKnowledgeIndex,
    semanticSearchReportKnowledge, setReportKnowledgeExternalizationEnabled } = await import('./report-knowledge.ts');

  const adminId = id('usr_');
  db.prepare(`INSERT INTO users(id,name,email,password_hash,role) VALUES (?,?,?,?,?)`)
    .run(adminId, '隔离报告知识管理员', `report-knowledge-${randomUUID()}@example.test`, 'synthetic', 'ADMIN');
  const reportId = id('rpt_');
  const versionId = id('rrv_');
  const sourceHash = createHash('sha256').update('synthetic report evidence for isolation test').digest('hex');
  db.prepare(`INSERT INTO research_reports(id,title,description,created_by) VALUES (?,?,?,?)`)
    .run(reportId, '合成蛋白浓度报告', '仅用于报告语义外发与 worker 竞态隔离验证', adminId);
  db.prepare(`INSERT INTO research_report_versions(id,report_id,version_no,original_name,storage_key,extension,mime_type,size_bytes,sha256,uploaded_by)
    VALUES (?,?,1,'fixture.txt',? ,'.txt','text/plain',40,?,?)`)
    .run(versionId, reportId, `rrf_${randomUUID()}.txt`, sourceHash, adminId);
  const manifest = currentReportManifest(reportId)!;
  const aiJob = transaction(() => writeJobFromManifest(reportId, adminId, manifest, 'report-knowledge-smoke'));
  db.prepare(`UPDATE ai_jobs SET status='completed',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(aiJob.id);
  const analysisId = id('ana_');
  const observationId = id('obs_');
  db.prepare(`INSERT INTO research_analyses(id,job_id,report_id,report_version_id,status,summary,structured_json,evidence_gaps_json,coverage_json,
      input_manifest_json,prompt_version,schema_version)
    VALUES (?,?,?,?, 'needs_review','本地合成结果','{}','[]','{}',?,'fixture','1')`)
    .run(analysisId, aiJob.id, reportId, versionId, JSON.stringify({ fingerprint: manifest.fingerprint }));
  db.prepare(`INSERT INTO research_observations(id,report_id,analysis_id,field_key,observation_type,review_state,value_json,normalized_text)
    VALUES (?,?,?,'protein_concentration','source_statement','machine_unconfirmed',?,?)`)
    .run(observationId, reportId, analysisId, JSON.stringify({ value: '1.25', unit: 'mg/mL' }), '1.25 mg/mL protein concentration');
  db.prepare(`INSERT INTO evidence_refs(id,observation_id,analysis_id,report_id,source_version_id,source_kind,content_sha256,locator_json,source_excerpt)
    VALUES (?,?,?,?,?,'report_version',?,?,?)`)
    .run(id('evr_'), observationId, analysisId, reportId, versionId, sourceHash, JSON.stringify({ kind: 'paragraph', paragraph: 1 }),
      'Protein concentration measured as 1.25 mg/mL in synthetic report.');

  equal(reportKnowledgeExternalizationEnabled(), false, '新数据库默认关闭报告知识外发');
  equal(enqueueAllCurrentReportKnowledge(), 0, '外发关闭时启动扫描不排入报告内容');
  equal(enqueueReportKnowledgeIndex(reportId), undefined, '外发关闭时分析事件不会排入报告向量任务');
  await saveLiteratureEmbeddingConfig(adminId, { baseUrl: `http://127.0.0.1:${embeddingPort}/v1`, model: 'synthetic-report-embedding',
    dimensions: 3, distance: 'Cosine', batchSize: 4, maxInputChars: 6000, timeoutMs: 5000, taskTokenBudget: 100, maxRequests: 10,
    queryTokenBudget: 100, queryMaxRequests: 10 });
  const callsBeforeDisabled = embeddingRequests;
  const disabledSearch = await semanticSearchReportKnowledge('蛋白浓度', undefined, 5, adminId);
  equal(disabledSearch.mode, 'keyword', '关闭外发时Agent报告知识检索退化为本地关键词');
  assert(disabledSearch.fallbackReason.includes('尚未由管理员启用'), '关闭状态明确返回外发许可说明');
  equal(embeddingRequests, callsBeforeDisabled, 'Embedding 已配置但报告开关关闭时不会发送报告或查询文本');
  equal(await processReportKnowledgeIndexOnce(), false, '关闭外发时 worker 不领取任务或调用 Qdrant/Embedding');
  equal(embeddingRequests, callsBeforeDisabled, '关闭状态 worker 没有产生 Embedding 请求');

  equal(setReportKnowledgeExternalizationEnabled(true, adminId).enabled, true, '管理员单独启用报告知识外发');
  const firstJobId = enqueueReportKnowledgeIndex(reportId)!;
  assert(firstJobId, '管理员启用后当前报告进入索引队列');
  let notifyEmbeddingStarted: (() => void) | undefined;
  const embeddingStart = new Promise<void>(resolve => { notifyEmbeddingStarted = resolve; });
  holdNextEmbedding = true;
  embeddingStarted = notifyEmbeddingStarted;
  const slowWorker = processReportKnowledgeIndexOnce();
  await embeddingStart;
  const jobBeforeEnqueue = db.prepare('SELECT status,lease_owner,attempt_count,request_count FROM report_knowledge_index_jobs WHERE id=?').get(firstJobId) as any;
  enqueueReportKnowledgeIndex(reportId);
  const jobAfterEnqueue = db.prepare('SELECT status,lease_owner,attempt_count,request_count FROM report_knowledge_index_jobs WHERE id=?').get(firstJobId) as any;
  equal(jobAfterEnqueue.status, 'working', '重复入队保持慢速 worker 的 working 状态');
  equal(jobAfterEnqueue.lease_owner, jobBeforeEnqueue.lease_owner, '重复入队保留活动租约 owner');
  equal(jobAfterEnqueue.attempt_count, jobBeforeEnqueue.attempt_count, '重复入队不重复消耗尝试次数');
  equal(jobAfterEnqueue.request_count, jobBeforeEnqueue.request_count, '重复入队不重复计 provider 请求数');
  const workerEnv = { ...process.env, IVD_TEST_MODE: '1', DATA_DIR: String(process.env.DATA_DIR), IVD_REPORT_KNOWLEDGE_WORKER_ONCE: '1' };
  const concurrentWorker = spawn(process.execPath, ['--experimental-strip-types', 'src/report-knowledge-worker.ts'],
    { cwd: process.cwd(), env: workerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let concurrentOutput = '';
  concurrentWorker.stdout.on('data', chunk => concurrentOutput += chunk);
  concurrentWorker.stderr.on('data', chunk => concurrentOutput += chunk);
  const concurrentExit = await new Promise<number>((resolve, reject) => {
    concurrentWorker.once('error', reject); concurrentWorker.once('close', code => resolve(code ?? 1));
  });
  equal(concurrentExit, 0, `第二个 worker 正常检查活动租约：${concurrentOutput}`);
  const requestsWhileFirstHeld = embeddingRequests;
  equal(requestsWhileFirstHeld, callsBeforeDisabled + 1, '多 worker 不会因60秒巡检/启动扫描重复发送慢请求');
  const retainedAfterWorker = db.prepare('SELECT status,lease_owner,attempt_count FROM report_knowledge_index_jobs WHERE id=?').get(firstJobId) as any;
  equal(retainedAfterWorker.status, 'working', '第二个 worker 没有抢占活动索引租约');
  releaseHeldEmbedding?.();
  await slowWorker;
  const firstJob = db.prepare('SELECT status,request_count FROM report_knowledge_index_jobs WHERE id=?').get(firstJobId) as any;
  equal(firstJob.status, 'complete', '慢请求完成后由原 worker 发布当前索引');
  equal(firstJob.request_count, 1, '慢任务全程只登记一次 Embedding 请求');

  queryObservationId = observationId;
  const semantic = await semanticSearchReportKnowledge('protein concentration', undefined, 5, adminId);
  equal(semantic.mode, 'semantic', '管理员启用后报告知识通过 Qdrant 语义检索');
  equal(semantic.observations[0]?.id, observationId, 'Qdrant 结果回查当前结构化报告观察');
  equal(semantic.observations[0]?.retrieval?.mode, 'qdrant', '语义结果标注真实 Qdrant 检索路径');
  assert(semantic.observations[0]?.evidence?.length, '语义结果保留可回查证据');

  const insertReview = (value: string) => db.prepare(`INSERT INTO observation_reviews(id,observation_id,reviewer_id,review_state,corrected_value_json,comment)
    VALUES (?,?,?,'corrected',?,'竞态合成更正')`).run(id('rev_'), observationId, adminId, JSON.stringify({ value, unit: 'mg/mL' }));
  insertReview('1.30');
  const oldFingerprintJob = enqueueReportKnowledgeIndex(reportId)!;
  let notifyUpsertStarted: (() => void) | undefined;
  const upsertStart = new Promise<void>(resolve => { notifyUpsertStarted = resolve; });
  holdNextUpsert = true;
  upsertStarted = notifyUpsertStarted;
  const oldPublishWorker = processReportKnowledgeIndexOnce();
  await upsertStart;
  const oldPublishRow = db.prepare('SELECT knowledge_fingerprint FROM report_knowledge_index_jobs WHERE id=?').get(oldFingerprintJob) as any;
  insertReview('1.42');
  const newFingerprintJob = enqueueReportKnowledgeIndex(reportId)!;
  assert(newFingerprintJob && newFingerprintJob !== oldFingerprintJob, '人工更正变化创建新的知识指纹任务');
  const newFingerprintRow = db.prepare('SELECT knowledge_fingerprint FROM report_knowledge_index_jobs WHERE id=?').get(newFingerprintJob) as any;
  assert(oldPublishRow.knowledge_fingerprint !== newFingerprintRow.knowledge_fingerprint, '新旧 worker 使用不同知识指纹');
  equal(await processReportKnowledgeIndexOnce(), true, '新指纹 worker 能在旧版本 Qdrant upsert 等待时发布');
  const newPoint = [...pointStore.values()].find(point => point.payload.report_id === reportId && point.payload.knowledge_fingerprint === newFingerprintRow.knowledge_fingerprint);
  assert(newPoint, '新版本 Qdrant 点已发布');
  releaseHeldUpsert?.();
  await oldPublishWorker;
  assert(pointStore.has(newPoint.id), '旧 worker 完成后不会按 report_id 删除新指纹点');
  equal(deleteRequests, 0, '索引发布不执行可能跨版本误删的按报告清理');
  equal((db.prepare('SELECT status FROM report_knowledge_index_jobs WHERE id=?').get(oldFingerprintJob) as any).status, 'superseded',
    '在新版本发布期间完成的旧 worker 标为过时');

  db.prepare(`UPDATE report_knowledge_index_jobs SET status='failed',attempt_count=max_attempts,request_count=1,usage_tokens=0,usage_status='unknown',
    error_code='attempts_exhausted',error_message='合成用尽尝试',finished_at=datetime('now') WHERE id=?`).run(newFingerprintJob);
  await reconcileReportKnowledgeIndexAfterRestore();
  equal((db.prepare('SELECT status FROM report_knowledge_index_jobs WHERE id=?').get(newFingerprintJob) as any).status, 'failed',
    '60秒恢复巡检不会无限重排已耗尽次数的失败任务');
  const attemptsBeforeRetry = db.prepare('SELECT attempt_count,max_attempts,request_count,usage_status FROM report_knowledge_index_jobs WHERE id=?').get(newFingerprintJob) as any;
  const retry = retryReportKnowledgeIndex(reportId);
  assert(retry.ok, '管理员显式重试可恢复达到 max_attempts 的当前失败任务');
  const attemptsAfterRetry = db.prepare('SELECT status,attempt_count,max_attempts,request_count,usage_status FROM report_knowledge_index_jobs WHERE id=?').get(newFingerprintJob) as any;
  equal(attemptsAfterRetry.status, 'queued', '显式重试进入新尝试窗口');
  equal(attemptsAfterRetry.attempt_count, attemptsBeforeRetry.attempt_count, '累计尝试次数保留而非归零');
  assert(attemptsAfterRetry.max_attempts > attemptsAfterRetry.attempt_count, '显式重试增加有限的新尝试额度');
  equal(attemptsAfterRetry.request_count, attemptsBeforeRetry.request_count, '重试不清空历史 Embedding 请求数');
  equal(attemptsAfterRetry.usage_status, 'unknown', '重试保留未知 usage 保护');
  const beforeCacheRetry = embeddingRequests;
  equal(await processReportKnowledgeIndexOnce(), true, '完整本地缓存可在不外呼时恢复 Qdrant 发布');
  equal(embeddingRequests, beforeCacheRetry, '恢复缓存完整任务时不重复向 Embedding 外发');
  equal((db.prepare('SELECT status FROM report_knowledge_index_jobs WHERE id=?').get(newFingerprintJob) as any).status, 'complete',
    '缓存重建完成后索引状态恢复为 complete');

  setReportKnowledgeExternalizationEnabled(false, adminId);
  const beforeClosedSearch = embeddingRequests;
  const closedSearch = await semanticSearchReportKnowledge('protein concentration', undefined, 5, adminId);
  equal(closedSearch.mode, 'keyword', '管理员关闭后 Agent 与页面回到关键词模式');
  equal(embeddingRequests, beforeClosedSearch, '关闭后语义检索不发送查询文本');
  process.stdout.write('REPORT KNOWLEDGE PASS: 默认外发关闭、管理许可、worker 互斥租约、跨 worker 慢请求、Qdrant 语义检索、旧指纹发布竞态、精确 ID 回查与有限重试恢复均通过。\n');
} finally {
  await close(embeddingServer);
  await close(qdrantServer);
}
