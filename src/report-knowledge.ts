import { createHash, randomUUID } from 'node:crypto';
import { db, id, transaction } from './db.ts';
import { getCurrentKnowledgeObservationsByIds, searchKnowledge, type KnowledgeFilters } from './ai/knowledge.ts';
import { getActiveLiteratureProfile, getLiteratureEmbeddingConfig, getLiteratureEmbeddingStatus } from './literature/embedding-config.ts';
import { beginLiteratureQueryUsage, settleLiteratureQueryUsage } from './literature/search.ts';
import { embedOpenAiCompatible, EmbeddingRequestError } from './literature/embedding-provider.ts';
import { deterministicPointId, ensureReportKnowledgeCollection, queryReportKnowledgePoints,
  reportKnowledgeCollectionName, reportKnowledgePointsPresent, upsertReportKnowledgePoints } from './literature/vector.ts';

type Row = Record<string, any>;
type KnowledgeData = ReturnType<typeof searchKnowledge>;
type Snapshot = { reportId: string; title: string; description: string; fingerprint: string; observations: Row[] };
const WORKER_ID = `rptkw_${process.pid}_${randomUUID()}`;
const LEASE_MS = 90_000;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sha256Buffer = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const parseJson = (value: string) => { try { return JSON.parse(value); } catch { return {}; } };
const EXPORT_SETTING = 'report_knowledge_externalization_enabled';

export function reportKnowledgeExternalizationEnabled() {
  const row = db.prepare('SELECT setting_value FROM system_settings WHERE setting_key=?').get(EXPORT_SETTING) as Row | undefined;
  return String(row?.setting_value || '').toLocaleLowerCase() === 'true';
}

export function setReportKnowledgeExternalizationEnabled(enabled: boolean, actorId: string) {
  const queuedFromConsent = transaction(() => {
    db.prepare(`INSERT INTO system_settings(setting_key,setting_value,updated_by,updated_at) VALUES (?,?,?,datetime('now'))
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(EXPORT_SETTING, enabled ? 'true' : 'false', actorId);
    if (!enabled) {
      db.prepare(`UPDATE report_knowledge_index_jobs SET status='waiting_configuration',error_code='report_knowledge_disabled',
        error_message='管理员已关闭报告知识语义外发；已发送中的请求完成后不会继续发送或发布。',lease_owner=NULL,lease_until_ms=NULL,
        next_attempt_at_ms=0,updated_at=datetime('now') WHERE status='queued'`).run();
    } else {
      const result = db.prepare(`UPDATE report_knowledge_index_jobs SET status='queued',error_code=NULL,error_message=NULL,
        max_attempts=MAX(max_attempts,attempt_count+1),lease_owner=NULL,lease_until_ms=NULL,next_attempt_at_ms=0,finished_at=NULL,
        updated_at=datetime('now') WHERE status='waiting_configuration' AND error_code='report_knowledge_disabled'`).run();
      db.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)`)
        .run(id('aud_'), actorId, 'report_knowledge.externalization', 'report_knowledge', '', JSON.stringify({ enabled, resumedJobs: result.changes }));
      return Number(result.changes || 0);
    }
    db.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)`)
      .run(id('aud_'), actorId, 'report_knowledge.externalization', 'report_knowledge', '', JSON.stringify({ enabled, pausedQueuedJobs: true }));
    return 0;
  });
  if (enabled) enqueueAllCurrentReportKnowledge();
  return { enabled: reportKnowledgeExternalizationEnabled(), queuedFromConsent };
}

function currentSnapshot(reportId: string): Snapshot | undefined {
  const report = db.prepare('SELECT id,title,description FROM research_reports WHERE id=? AND deleted_at IS NULL').get(reportId) as Row | undefined;
  if (!report) return undefined;
  const data = searchKnowledge({ reportIds: [reportId], limit: 2000 });
  const observations = data.observations as Row[];
  const fingerprintPayload = { reportId, title: String(report.title), description: String(report.description || ''), observations: observations.map(item => ({
    id: item.id, value: item.value, reviewState: item.reviewState, reviewVersion: item.reviewVersion, summary: item.summary,
    evidence: (item.evidence || []).map((source: Row) => ({ sourceVersionId: source.sourceVersionId, contentSha256: source.contentSha256,
      locator: source.locator, excerpt: source.excerpt })),
  })) };
  return { reportId, title: String(report.title), description: String(report.description || ''), fingerprint: sha256(JSON.stringify(fingerprintPayload)), observations };
}

export function enqueueReportKnowledgeIndex(reportIdRaw: unknown, forceRebuild = false) {
  const reportId = String(reportIdRaw || '').trim();
  if (!reportId || !reportKnowledgeExternalizationEnabled()) return undefined;
  const snapshot = currentSnapshot(reportId);
  if (!snapshot || !snapshot.observations.length) return undefined;
  return transaction(() => {
    const existing = db.prepare('SELECT id,status,attempt_count,max_attempts,lease_until_ms FROM report_knowledge_index_jobs WHERE report_id=? AND knowledge_fingerprint=?')
      .get(reportId, snapshot.fingerprint) as Row | undefined;
    if (existing) {
      const jobId = String(existing.id);
      if (existing.status === 'working') return jobId;
      if (existing.status === 'queued') return jobId;
      if (existing.status === 'complete' && !forceRebuild) return jobId;
      if (['failed','partial','superseded'].includes(String(existing.status)) && !forceRebuild) return jobId;
      if (existing.status === 'complete' && forceRebuild || ['failed','partial'].includes(String(existing.status)) && forceRebuild
        || existing.status === 'waiting_configuration') {
        db.prepare(`UPDATE report_knowledge_index_jobs SET status='queued',error_code=NULL,error_message=NULL,lease_owner=NULL,lease_until_ms=NULL,
          max_attempts=MAX(max_attempts,attempt_count+1),next_attempt_at_ms=0,updated_at=datetime('now'),finished_at=NULL WHERE id=?`)
          .run(jobId);
      }
      return jobId;
    }
    const jobId = id('rki_');
    db.prepare(`INSERT INTO report_knowledge_index_jobs(id,report_id,knowledge_fingerprint,status,attempt_count,request_count,usage_tokens,usage_status,
      error_code,error_message,lease_owner,lease_until_ms,next_attempt_at_ms,created_at,updated_at,finished_at)
      VALUES (?,?,?,'queued',0,0,0,'none',NULL,NULL,NULL,NULL,0,datetime('now'),datetime('now'),NULL)`)
      .run(jobId, reportId, snapshot.fingerprint);
    return jobId;
  });
}

export function enqueueAllCurrentReportKnowledge() {
  if (!reportKnowledgeExternalizationEnabled()) return 0;
  const reports = db.prepare(`SELECT DISTINCT r.id FROM research_reports r JOIN research_analyses a ON a.report_id=r.id
    WHERE r.deleted_at IS NULL AND a.status IN ('completed','partial','needs_review') ORDER BY r.id`).all() as Row[];
  let queued = 0;
  for (const row of reports) if (enqueueReportKnowledgeIndex(String(row.id))) queued++;
  return queued;
}

export async function reconcileReportKnowledgeIndexAfterRestore() {
  if (!reportKnowledgeExternalizationEnabled()) return 0;
  const active = getActiveLiteratureProfile();
  const status = getLiteratureEmbeddingStatus();
  const reports = db.prepare(`SELECT DISTINCT r.id FROM research_reports r JOIN research_analyses a ON a.report_id=r.id
    WHERE r.deleted_at IS NULL AND a.status IN ('completed','partial','needs_review') ORDER BY r.id`).all() as Row[];
  let queued = 0;
  for (const row of reports) {
    const reportId = String(row.id);
    const snapshot = currentSnapshot(reportId);
    if (!snapshot?.observations.length) continue;
    const complete = db.prepare(`SELECT id FROM report_knowledge_index_jobs WHERE report_id=? AND knowledge_fingerprint=? AND status='complete'`)
      .get(reportId, snapshot.fingerprint) as Row | undefined;
    if (complete && active && status.qdrant.configured) {
      const collection = reportKnowledgeCollectionName(String(active.fingerprint), Number(active.generation || 1));
      const pointIds = snapshot.observations.map(item => deterministicPointId(String(active.id), String(item.id), snapshot.fingerprint));
      try { if (await reportKnowledgePointsPresent(collection, pointIds)) continue; }
      catch { continue; }
    }
    if (enqueueReportKnowledgeIndex(reportId, Boolean(complete))) queued++;
  }
  return queued;
}

export function reportKnowledgeIndexStatus() {
  const embedding = getLiteratureEmbeddingStatus();
  const activeJobs = Number((db.prepare(`SELECT COUNT(*) AS n FROM report_knowledge_index_jobs
    WHERE status IN ('queued','waiting_configuration','working') AND COALESCE(error_code,'')!='report_knowledge_disabled'`).get() as Row).n);
  const completedReports = Number((db.prepare(`SELECT COUNT(DISTINCT j.report_id) AS n FROM report_knowledge_index_jobs j
    JOIN research_reports r ON r.id=j.report_id AND r.deleted_at IS NULL
    WHERE j.status='complete' AND j.knowledge_fingerprint=(SELECT j2.knowledge_fingerprint FROM report_knowledge_index_jobs j2
      WHERE j2.report_id=j.report_id ORDER BY j2.rowid DESC LIMIT 1)`).get() as Row).n);
  const latest = db.prepare(`SELECT j.*,r.title AS report_title FROM report_knowledge_index_jobs j JOIN (
      SELECT report_id,MAX(rowid) AS latest_row FROM report_knowledge_index_jobs GROUP BY report_id
    ) x ON x.latest_row=j.rowid JOIN research_reports r ON r.id=j.report_id WHERE r.deleted_at IS NULL
    ORDER BY j.updated_at DESC LIMIT 20`).all() as Row[];
  const profile = getActiveLiteratureProfile();
  const config = embedding.config;
  return { enabled: reportKnowledgeExternalizationEnabled(), completedReports, activeJobs, jobs: latest.map(job => ({ id: job.id,
    reportId: job.report_id, title: String(job.report_title || ''), status: job.status, attemptCount: Number(job.attempt_count || 0),
    maxAttempts: Number(job.max_attempts || 0), usageTokens: Number(job.usage_tokens || 0), usageStatus: job.usage_status,
    errorCode: job.error_code, updatedAt: job.updated_at })),
    qdrant: { configured: embedding.qdrant.configured, endpoint: embedding.qdrant.url, namespace: 'ivd_rpt_*' },
    embedding: { configured: Boolean(profile && embedding.embedding.keyConfigured), status: profile && embedding.embedding.keyConfigured ? 'configured' : 'waiting_configuration',
      model: profile?.model || config.model || '', endpoint: config.baseUrl, dimensions: Number(profile?.dimensions || config.dimensions || 0),
      dataNotice: '报告索引发送标题、说明、当前有效结构化观察及相应证据摘录；Agent 语义检索时会发送查询词。完整报告文件、原始数据附件与会话不进入此索引。报告与文献使用不同的 Qdrant 集合。' },
    worker: { required: true, command: 'npm run report-knowledge:worker' } };
}

export function retryReportKnowledgeIndex(reportIdRaw: unknown) {
  if (!reportKnowledgeExternalizationEnabled()) return { ok: false as const, reason: 'disabled' as const };
  const reportId = String(reportIdRaw || '').trim();
  const snapshot = currentSnapshot(reportId);
  if (!snapshot || !snapshot.observations.length) return { ok: false as const, reason: 'no_current_knowledge' as const };
  const changed = db.prepare(`UPDATE report_knowledge_index_jobs SET status='queued',max_attempts=MAX(max_attempts,attempt_count)+3,
    next_attempt_at_ms=0,error_code=NULL,error_message=NULL,lease_owner=NULL,lease_until_ms=NULL,finished_at=NULL,updated_at=datetime('now')
    WHERE report_id=? AND knowledge_fingerprint=? AND status IN ('failed','partial')`).run(reportId, snapshot.fingerprint);
  if (changed.changes) return { ok: true as const, id: String((db.prepare(`SELECT id FROM report_knowledge_index_jobs WHERE report_id=? AND knowledge_fingerprint=?`)
    .get(reportId, snapshot.fingerprint) as Row).id) };
  const existing = db.prepare('SELECT id,status FROM report_knowledge_index_jobs WHERE report_id=? AND knowledge_fingerprint=?')
    .get(reportId, snapshot.fingerprint) as Row | undefined;
  if (existing && ['queued','working','waiting_configuration'].includes(String(existing.status))) return { ok: true as const, id: String(existing.id) };
  if (!existing) return { ok: true as const, id: enqueueReportKnowledgeIndex(reportId) || '' };
  return { ok: false as const, reason: String(existing.status) };
}

function currentScopes(reportIds?: string[]) {
  const ids = reportIds === undefined
    ? (db.prepare('SELECT id FROM research_reports WHERE deleted_at IS NULL ORDER BY id').all() as Row[]).map(row => String(row.id))
    : [...new Set(reportIds.map(id => String(id).trim()).filter(Boolean))];
  const scopes: Array<{ reportId: string; fingerprint: string }> = [];
  for (const reportId of ids) {
    const snapshot = currentSnapshot(reportId);
    if (snapshot?.observations.length) scopes.push({ reportId, fingerprint: snapshot.fingerprint });
  }
  return scopes;
}

function profileForVector(profile: Row, config: ReturnType<typeof getLiteratureEmbeddingConfig>) {
  return { baseUrl: String(profile.endpoint_url || config.baseUrl), model: String(profile.model), dimensions: Number(profile.dimensions),
    distance: String(profile.distance), sendDimensions: Boolean(profile.send_dimensions), maxInputChars: config.maxInputChars, timeoutMs: config.timeoutMs };
}

export async function semanticSearchReportKnowledge(queryRaw: unknown, reportIds?: string[], limitRaw = 20, actorId = ''):
  Promise<{ mode: 'semantic' | 'keyword'; fallbackReason: string; observations: Row[]; reports: Row[] }> {
  const query = String(queryRaw || '').trim().slice(0, 200);
  const limit = Math.max(1, Math.min(40, Number(limitRaw || 20)));
  const keyword = searchKnowledge({ q: query, reportIds, limit: Math.max(50, limit) });
  if (!query) return { mode: 'keyword', fallbackReason: '', observations: keyword.observations, reports: keyword.reports };
  if (!reportKnowledgeExternalizationEnabled()) return { mode: 'keyword', fallbackReason: '报告知识语义外发尚未由管理员启用，使用本地关键词检索。', observations: keyword.observations, reports: keyword.reports };
  const status = getLiteratureEmbeddingStatus();
  const active = getActiveLiteratureProfile();
  if (!active || !status.embedding.keyConfigured || !status.qdrant.configured) return { mode: 'keyword', fallbackReason: 'Embedding 或 Qdrant 尚未配置，使用关键词检索。', observations: keyword.observations, reports: keyword.reports };
  const scopes = currentScopes(reportIds);
  if (!scopes.length) return { mode: 'keyword', fallbackReason: '所选范围没有当前有效的结构化报告知识。', observations: [], reports: [] };
  const config = getLiteratureEmbeddingConfig();
  const begin = beginLiteratureQueryUsage(actorId, String(active.id), config);
  if (!begin.ok) return { mode: 'keyword', fallbackReason: begin.reason === 'query_usage_unknown'
    ? '今日 Embedding 用量有未确认请求，已停止语义请求并降级为关键词检索。'
    : begin.reason === 'query_request_budget' ? '今日语义查询请求数已达上限，使用关键词检索。' : '今日语义查询 token 预算已达上限，使用关键词检索。',
    observations: keyword.observations, reports: keyword.reports };
  const profile = profileForVector(active, config);
  const collection = reportKnowledgeCollectionName(String(active.fingerprint), Number(active.generation || 1));
  let embedded: Awaited<ReturnType<typeof embedOpenAiCompatible>> | undefined;
  let settled = false;
  try {
    embedded = await embedOpenAiCompatible([`${String(active.query_prefix || '')}${query}`], profile);
    settleLiteratureQueryUsage(actorId, String(active.id), begin.date, embedded.usage);
    settled = true;
    if (embedded.model && embedded.model !== profile.model) throw new Error('Embedding 响应模型与当前 profile 不同');
    const points = await queryReportKnowledgePoints(collection, embedded.vectors[0], limit, scopes);
    const scopeByReport = new Map(scopes.map(scope => [scope.reportId, scope.fingerprint]));
    const observationsById = new Map(getCurrentKnowledgeObservationsByIds(points.map(point => String(point.payload.observation_id || '')))
      .map((item: Row) => [String(item.id), item]));
    const observations: Row[] = [];
    const seen = new Set<string>();
    for (const point of points) {
      const reportId = String(point.payload.report_id || '');
      const fingerprint = String(point.payload.knowledge_fingerprint || '');
      const observationId = String(point.payload.observation_id || '');
      if (scopeByReport.get(reportId) !== fingerprint || seen.has(observationId)) continue;
      const observation = observationsById.get(observationId);
      if (!observation || observation.reportId !== reportId || !observation.evidence?.length) continue;
      seen.add(observationId); observations.push({ ...observation, retrieval: { mode: 'qdrant', score: point.score } });
    }
    const foundReports = [...new Set(observations.map(item => String(item.reportId)))];
    const reportMap = new Map(keyword.reports.map((report: Row) => [String(report.id), report]));
    for (const reportId of foundReports) {
      if (reportMap.has(reportId)) continue;
      const report = db.prepare('SELECT id,title,description,created_at,updated_at FROM research_reports WHERE id=? AND deleted_at IS NULL').get(reportId) as Row | undefined;
      if (report) reportMap.set(reportId, { id: String(report.id), title: String(report.title), description: String(report.description), createdAt: String(report.created_at), updatedAt: String(report.updated_at) });
    }
    return { mode: 'semantic', fallbackReason: '', observations, reports: [...reportMap.values()].filter((report: Row) => reportIds === undefined || reportIds.includes(String(report.id))).slice(0, 40) };
  } catch (error) {
    if (!settled) {
      const failure = error instanceof EmbeddingRequestError ? error : undefined;
      settleLiteratureQueryUsage(actorId, String(active.id), begin.date,
        { status: failure?.usageOutcome === 'rejected' ? 'known' : 'unknown', totalTokens: null }, failure?.code || 'report_query_unknown');
    }
    return { mode: 'keyword', fallbackReason: `报告知识向量检索不可用，使用关键词检索（${(error as Error).message.slice(0, 150)}）。`,
      observations: keyword.observations, reports: keyword.reports };
  }
}

function ownsLease(job: Row) {
  return Boolean(db.prepare(`SELECT 1 FROM report_knowledge_index_jobs WHERE id=? AND status='working' AND lease_owner=?
    AND attempt_count=? AND lease_until_ms>?`).get(job.id, job.lease_owner, job.attempt_count, Date.now()));
}

function claimIndexJob() {
  if (!reportKnowledgeExternalizationEnabled()) {
    const now = Date.now();
    db.prepare(`UPDATE report_knowledge_index_jobs SET status='waiting_configuration',lease_owner=NULL,lease_until_ms=NULL,
      error_code='report_knowledge_disabled',error_message='管理员尚未单独启用报告知识语义外发。',updated_at=datetime('now')
      WHERE status='queued' OR (status='working' AND COALESCE(lease_until_ms,0)<=?)`).run(now);
    return undefined;
  }
  const active = getActiveLiteratureProfile();
  const status = getLiteratureEmbeddingStatus();
  if (!active || !status.qdrant.configured) {
    db.prepare(`UPDATE report_knowledge_index_jobs SET status='waiting_configuration',lease_owner=NULL,lease_until_ms=NULL,
      error_code='waiting_configuration',error_message='请配置服务端 Embedding 与 Qdrant 后启动索引',updated_at=datetime('now')
      WHERE status='queued' OR (status='working' AND COALESCE(lease_until_ms,0)<=?)`).run(Date.now());
    return undefined;
  }
  const now = Date.now();
  db.prepare(`UPDATE report_knowledge_index_jobs SET status='failed',lease_owner=NULL,lease_until_ms=NULL,finished_at=datetime('now'),
    error_code='attempts_exhausted',error_message='工作进程租约到期，且本轮最大尝试次数已用尽；管理员可检查原因后显式重试。',updated_at=datetime('now')
    WHERE status='working' AND COALESCE(lease_until_ms,0)<=? AND attempt_count>=max_attempts`).run(now);
  const job = transaction(() => {
    const candidate = db.prepare(`SELECT * FROM report_knowledge_index_jobs WHERE next_attempt_at_ms<=? AND
      (status='queued' OR (status='working' AND COALESCE(lease_until_ms,0)<=?))
      AND attempt_count<max_attempts ORDER BY created_at,rowid LIMIT 1`).get(now, now) as Row | undefined;
    if (!candidate) return undefined;
    const leaseUntil = now + Math.max(LEASE_MS, getLiteratureEmbeddingConfig().timeoutMs + 30_000);
    const changed = db.prepare(`UPDATE report_knowledge_index_jobs SET status='working',attempt_count=attempt_count+1,lease_owner=?,lease_until_ms=?,
      error_code=NULL,error_message=NULL,updated_at=datetime('now') WHERE id=? AND (status='queued' OR (status='working' AND COALESCE(lease_until_ms,0)<=?))`)
      .run(WORKER_ID, leaseUntil, candidate.id, now);
    if (!changed.changes) return undefined;
    return db.prepare('SELECT * FROM report_knowledge_index_jobs WHERE id=?').get(candidate.id) as Row;
  });
  return job;
}

function finishJob(job: Row, status: string, errorCode: string | null = null, errorMessage: string | null = null) {
  db.prepare(`UPDATE report_knowledge_index_jobs SET status=?,error_code=?,error_message=?,lease_owner=NULL,lease_until_ms=NULL,
    updated_at=datetime('now'),finished_at=CASE WHEN ? IN ('complete','partial','failed','superseded') THEN datetime('now') ELSE NULL END
    WHERE id=? AND status='working' AND lease_owner=? AND attempt_count=? AND lease_until_ms>?`)
    .run(status, errorCode, errorMessage?.slice(0, 800) || null, status, job.id, job.lease_owner, job.attempt_count, Date.now());
}

export async function processReportKnowledgeIndexOnce() {
  if (!reportKnowledgeExternalizationEnabled()) { claimIndexJob(); return false; }
  const job = claimIndexJob();
  if (!job) return false;
  const latest = currentSnapshot(String(job.report_id));
  if (!latest || latest.fingerprint !== job.knowledge_fingerprint) {
    finishJob(job, 'superseded', 'source_changed', '报告或人工复核状态已变化，当前索引任务已失效。');
    if (latest?.observations.length) enqueueReportKnowledgeIndex(latest.reportId);
    return true;
  }
  const active = getActiveLiteratureProfile();
  const config = getLiteratureEmbeddingConfig();
  if (!active) { finishJob(job, 'waiting_configuration', 'waiting_configuration', 'Embedding profile 尚未配置。'); return true; }
  const profile = profileForVector(active, config);
  const collection = reportKnowledgeCollectionName(String(active.fingerprint), Number(active.generation || 1));
  const inputs = latest.observations.map(item => `${String(active.document_prefix || '')}${[latest.title, latest.description, item.summary, item.fieldKey,
    JSON.stringify(item.value), ...item.evidence.map((source: Row) => source.excerpt)].filter(Boolean).join('\n')}`);
  if (!ownsLease(job)) return true;
  try { await ensureReportKnowledgeCollection(collection, profile.dimensions, profile.distance); }
  catch (error) { finishJob(job, 'failed', String((error as any).code || 'qdrant_unavailable'), (error as Error).message); return true; }
  const vectors: Array<number[] | undefined> = Array(inputs.length);
  const inputHashes = inputs.map(sha256);
  const cacheEmbedding = (inputHash: string, vector: number[], usageStatus: 'known' | 'unknown', tokens: number | null, responseId = '') => {
    const floats = Float32Array.from(vector);
    const blob = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
    db.prepare(`INSERT INTO report_knowledge_embedding_cache(profile_id,input_sha256,dimensions,vector_blob,vector_sha256,usage_tokens,usage_status,response_id)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,input_sha256) DO NOTHING`)
      .run(active.id, inputHash, profile.dimensions, blob, sha256Buffer(blob), tokens, usageStatus, responseId.slice(0, 200));
  };
  for (let index = 0; index < inputs.length; index++) {
    const cached = db.prepare(`SELECT * FROM report_knowledge_embedding_cache WHERE profile_id=? AND input_sha256=?`).get(active.id, inputHashes[index]) as Row | undefined;
    if (!cached) continue;
    const blob = Buffer.from(cached.vector_blob as Uint8Array);
    if (Number(cached.dimensions) !== profile.dimensions || blob.byteLength !== profile.dimensions * 4 || sha256Buffer(blob) !== cached.vector_sha256) {
      finishJob(job, 'failed', 'embedding_cache_corrupt', '本地报告知识向量缓存校验失败。'); return true;
    }
    vectors[index] = Array.from(new Float32Array(blob.buffer, blob.byteOffset, profile.dimensions));
  }
  let requestFailed = false;
  let usageUnknown = false;
  const missing = inputs.map((_input, index) => index).filter(index => !vectors[index]);
  const currentUsage = db.prepare('SELECT usage_status FROM report_knowledge_index_jobs WHERE id=?').get(job.id) as Row | undefined;
  if (missing.length && ['unknown','partial_unknown'].includes(String(currentUsage?.usage_status || ''))) {
    finishJob(job, 'partial', 'usage_unknown', '历史 Embedding 用量未确认，缺失向量未重发请求；请保持当前输入不变并先核查服务端用量。');
    return true;
  }
  if (missing.length && !String(process.env.IVD_EMBEDDING_API_KEY || '').trim()) {
    finishJob(job, 'waiting_configuration', 'waiting_embedding_key', '本地没有完整向量缓存；请配置服务端 Embedding 密钥后继续索引。'); return true;
  }
  for (let offset = 0; offset < missing.length; offset += Math.max(1, Math.min(64, config.batchSize))) {
    if (!ownsLease(job)) return true;
    if (!reportKnowledgeExternalizationEnabled()) {
      finishJob(job, 'waiting_configuration', 'report_knowledge_disabled', '管理员已关闭报告知识语义外发。');
      return true;
    }
    const currentProfile = getActiveLiteratureProfile();
    if (!currentProfile || currentProfile.id !== active.id || currentProfile.fingerprint !== active.fingerprint) {
      finishJob(job, 'superseded', 'profile_changed', 'Embedding profile 已变化，索引停止。'); return true;
    }
    const fresh = currentSnapshot(String(job.report_id));
    if (!fresh || fresh.fingerprint !== job.knowledge_fingerprint) { finishJob(job, 'superseded', 'source_changed', '报告在索引期间发生变化。'); return true; }
    const requestCount = Number((db.prepare('SELECT request_count FROM report_knowledge_index_jobs WHERE id=? AND lease_owner=? AND attempt_count=?').get(job.id, job.lease_owner, job.attempt_count) as Row | undefined)?.request_count || 0);
    const usedTokens = Number(job.usage_tokens || 0);
    if (requestCount >= config.maxRequests || usedTokens >= config.taskTokenBudget) {
      finishJob(job, 'partial', requestCount >= config.maxRequests ? 'request_budget' : 'token_budget', '報告知识向量任务达到 Embedding 请求数或累计 token 预算。');
      return true;
    }
    const indexes = missing.slice(offset, offset + Math.max(1, Math.min(64, config.batchSize)));
    const changed = db.prepare(`UPDATE report_knowledge_index_jobs SET request_count=request_count+1,lease_until_ms=?,updated_at=datetime('now')
      WHERE id=? AND status='working' AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND request_count<? AND usage_tokens<?`)
      .run(Date.now() + Math.max(LEASE_MS, config.timeoutMs + 30_000), job.id, job.lease_owner, job.attempt_count, Date.now(), config.maxRequests, config.taskTokenBudget);
    if (!changed.changes) { finishJob(job, 'partial', 'budget_or_lease', '请求预算已用尽或索引租约已失效。'); return true; }
    try {
      const embedded = await embedOpenAiCompatible(indexes.map(index => inputs[index]), profile);
      if (embedded.model && embedded.model !== profile.model) { finishJob(job, 'failed', 'embedding_model_mismatch', 'Embedding 响应模型与活动 profile 不一致。'); return true; }
      if (embedded.usage.status === 'known' && embedded.usage.totalTokens !== null) {
        db.prepare(`UPDATE report_knowledge_index_jobs SET usage_tokens=usage_tokens+?,usage_status='known',updated_at=datetime('now')
          WHERE id=? AND status='working' AND lease_owner=? AND attempt_count=? AND lease_until_ms>?`)
          .run(embedded.usage.totalTokens, job.id, job.lease_owner, job.attempt_count, Date.now());
        job.usage_tokens = usedTokens + embedded.usage.totalTokens;
      } else {
        db.prepare(`UPDATE report_knowledge_index_jobs SET usage_status=CASE WHEN usage_tokens>0 THEN 'partial_unknown' ELSE 'unknown' END,
          error_code='usage_unknown',error_message='Embedding 响应缺少可信 usage；不再发送后续批次。',updated_at=datetime('now')
          WHERE id=? AND status='working' AND lease_owner=? AND attempt_count=? AND lease_until_ms>?`)
          .run(job.id, job.lease_owner, job.attempt_count, Date.now());
        usageUnknown = true;
      }
      if (!reportKnowledgeExternalizationEnabled()) {
        finishJob(job, 'waiting_configuration', 'report_knowledge_disabled', '本批 Embedding 请求已完成并记录可得用量；管理员已关闭外发，后续索引暂停。');
        return true;
      }
      indexes.forEach((index, localIndex) => { vectors[index] = embedded.vectors[localIndex]; });
      indexes.forEach((index, localIndex) => cacheEmbedding(inputHashes[index], embedded!.vectors[localIndex], embedded!.usage.status,
        embedded!.usage.status === 'known' ? embedded!.usage.totalTokens : null, embedded!.usage.responseId));
    } catch (error) {
      const failure = error instanceof EmbeddingRequestError ? error : new EmbeddingRequestError('Embedding 请求结果未知。', 'embedding_unknown', false, 'unknown');
      if (!reportKnowledgeExternalizationEnabled()) {
        if (failure.usageOutcome === 'unknown') db.prepare(`UPDATE report_knowledge_index_jobs SET usage_status=CASE WHEN usage_tokens>0 THEN 'partial_unknown' ELSE 'unknown' END,
          error_code=?,error_message=?,updated_at=datetime('now') WHERE id=? AND status='working' AND lease_owner=? AND attempt_count=?`)
          .run(failure.code, failure.message.slice(0, 800), job.id, job.lease_owner, job.attempt_count);
        finishJob(job, 'waiting_configuration', 'report_knowledge_disabled', '管理员已关闭报告知识语义外发；请求结果已按可得用量留痕。');
        return true;
      }
      if (failure.usageOutcome === 'unknown') {
        db.prepare(`UPDATE report_knowledge_index_jobs SET usage_status=CASE WHEN usage_tokens>0 THEN 'partial_unknown' ELSE 'unknown' END,
          error_code=?,error_message=?,updated_at=datetime('now') WHERE id=? AND status='working' AND lease_owner=? AND attempt_count=? AND lease_until_ms>?`)
          .run(failure.code, failure.message.slice(0, 800), job.id, job.lease_owner, job.attempt_count, Date.now());
        finishJob(job, 'partial', failure.code, failure.message);
      } else if (failure.retryable && Number(job.attempt_count) < Number(job.max_attempts)) {
        const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, Number(job.attempt_count) - 1));
        db.prepare(`UPDATE report_knowledge_index_jobs SET status='queued',next_attempt_at_ms=?,lease_owner=NULL,lease_until_ms=NULL,
          error_code=?,error_message=?,updated_at=datetime('now') WHERE id=? AND status='working' AND lease_owner=? AND attempt_count=? AND lease_until_ms>?`)
          .run(Date.now() + delay, failure.code, failure.message.slice(0, 800), job.id, job.lease_owner, job.attempt_count, Date.now());
      } else finishJob(job, 'failed', failure.code, failure.message);
      requestFailed = true;
      break;
    }
    if (usageUnknown) break;
  }
  if (requestFailed || !ownsLease(job)) return true;
  const freshBeforePublish = currentSnapshot(String(job.report_id));
  if (!freshBeforePublish || freshBeforePublish.fingerprint !== job.knowledge_fingerprint) { finishJob(job, 'superseded', 'source_changed', '报告在发布向量前发生变化。'); return true; }
  const currentProfile = getActiveLiteratureProfile();
  if (!currentProfile || currentProfile.id !== active.id || currentProfile.fingerprint !== active.fingerprint) {
    finishJob(job, 'superseded', 'profile_changed', 'Embedding profile 已变化，拒绝发布旧索引。'); return true;
  }
  const points = latest.observations.flatMap((item, index) => vectors[index] ? [{
    id: deterministicPointId(String(active.id), String(item.id), String(job.knowledge_fingerprint)), vector: vectors[index]!,
    payload: { report_id: String(job.report_id), observation_id: String(item.id), knowledge_fingerprint: String(job.knowledge_fingerprint),
      evidence_ref_ids: item.evidence.map((source: Row) => source.id), source_hashes: item.evidence.map((source: Row) => source.contentSha256),
      review_state: item.reviewState, field_key: item.fieldKey },
  }] : []);
  if (!reportKnowledgeExternalizationEnabled()) {
    finishJob(job, 'waiting_configuration', 'report_knowledge_disabled', '管理员已关闭报告知识语义外发。');
    return true;
  }
  try {
    await upsertReportKnowledgePoints(collection, profile.dimensions, profile.distance, points);
  } catch (error) { finishJob(job, 'failed', String((error as any).code || 'qdrant_unavailable'), (error as Error).message); return true; }
  // Stale fingerprints are excluded by semantic scope validation. An older worker must never
  // delete points published by a newer worker for the same report.
  if (!ownsLease(job)) return true;
  const freshAfterPublish = currentSnapshot(String(job.report_id));
  if (!freshAfterPublish || freshAfterPublish.fingerprint !== job.knowledge_fingerprint) {
    finishJob(job, 'superseded', 'source_changed', '发布期间报告知识版本已变化；旧版本点保留但不会进入当前检索范围。');
    if (freshAfterPublish?.observations.length) enqueueReportKnowledgeIndex(freshAfterPublish.reportId);
    return true;
  }
  if (usageUnknown) finishJob(job, 'partial', 'usage_unknown', '本批向量已保存；Embedding usage 未知，后续请求已停止。');
  else finishJob(job, 'complete');
  return true;
}

export async function runReportKnowledgeWorker(signal?: AbortSignal) {
  if (reportKnowledgeExternalizationEnabled()) {
    enqueueAllCurrentReportKnowledge();
    await reconcileReportKnowledgeIndexAfterRestore();
  }
  let nextRestoreScan = Date.now() + 60_000;
  while (!signal?.aborted) {
    if (Date.now() >= nextRestoreScan) {
      if (reportKnowledgeExternalizationEnabled()) await reconcileReportKnowledgeIndexAfterRestore();
      nextRestoreScan = Date.now() + 60_000;
    }
    const processed = await processReportKnowledgeIndexOnce();
    if (!processed) await new Promise(resolve => {
      const timer = setTimeout(resolve, Math.min(1500, Math.max(250, nextRestoreScan - Date.now())));
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
    });
  }
}

export function searchReportKnowledgeKeywords(filters: KnowledgeFilters = {}): KnowledgeData {
  return searchKnowledge(filters);
}
