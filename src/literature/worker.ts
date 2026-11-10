import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { db, id, transaction } from '../db.ts';
import { enqueueLiteratureIndex, safeLiteraturePath } from './repository.ts';
import { LITERATURE_PARSER_VERSION, parseLiteratureFile } from './parser.ts';
import { getLiteratureEmbeddingConfig, getLiteratureEmbeddingStatus, getActiveLiteratureProfile } from './embedding-config.ts';
import { embedOpenAiCompatible, EmbeddingRequestError } from './embedding-provider.ts';
import { deterministicPointId, deleteLiteratureGeneration, ensureLiteratureCollection, upsertLiteraturePoints } from './vector.ts';

type Row = Record<string, any>;
const WORKER_ID = `litw_${process.pid}_${randomUUID()}`;
const LEASE_MS = 90_000;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function event(jobId: string, eventType: string, message: string, metadata: Row = {}) {
  const sequence = Number((db.prepare('SELECT COALESCE(MAX(sequence_no),0) AS n FROM literature_job_events WHERE job_id=?').get(jobId) as Row).n) + 1;
  db.prepare('INSERT INTO literature_job_events(id,job_id,sequence_no,event_type,message,metadata_json) VALUES (?,?,?,?,?,?)')
    .run(id('lje_'), jobId, sequence, eventType, message.slice(0, 1000), JSON.stringify(metadata));
}

function heartbeat(status: string, activeJobId: string | null = null, detail: Row = {}) {
  db.prepare(`INSERT INTO literature_worker_heartbeats(worker_id,process_id,last_seen_ms,status,active_job_id,detail_json)
    VALUES (?,?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms,status=excluded.status,
    active_job_id=excluded.active_job_id,detail_json=excluded.detail_json`)
    .run(WORKER_ID, process.pid, Date.now(), status, activeJobId, JSON.stringify(detail));
}

function expireLeases(now: number) {
  const stale = db.prepare(`SELECT * FROM literature_jobs WHERE status IN ('parsing','embedding','publishing') AND lease_until_ms IS NOT NULL AND lease_until_ms<=?`).all(now) as Row[];
  if (!stale.length) return;
  transaction(() => {
    for (const job of stale) {
      const pending = Number(job.usage_pending_count || 0);
      const unknown = pending > 0 || ['unknown','partial_unknown'].includes(String(job.usage_status));
      const terminal = Number(job.attempt_count) >= Number(job.max_attempts);
      const status = unknown ? 'partial' : terminal ? 'failed' : 'queued';
      const changed = db.prepare(`UPDATE literature_jobs SET status=?,lease_owner=NULL,lease_until_ms=NULL,updated_at=datetime('now'),
        finished_at=CASE WHEN ?=1 THEN datetime('now') ELSE finished_at END,error_code=?,
        error_message=?,usage_pending_count=0,usage_unknown_count=usage_unknown_count+?,
        usage_status=CASE WHEN ?>0 THEN CASE WHEN usage_tokens>0 THEN 'partial_unknown' ELSE 'unknown' END ELSE usage_status END,
        usage_stop_reason=CASE WHEN ?>0 THEN 'worker_lease_expired_pending_usage_unknown' ELSE usage_stop_reason END
        WHERE id=? AND status IN ('parsing','embedding','publishing') AND lease_until_ms<=?`)
        .run(status, status === 'queued' ? 0 : 1, unknown ? 'usage_unknown' : 'worker_lease_expired',
          unknown ? 'Worker 租约到期时存在未结算或未知 Embedding 用量，已停止后续请求。' : terminal
            ? '文献 Worker 租约到期且已达到最大尝试次数。' : '文献 Worker 租约到期，任务重新排队。', pending, pending, pending, job.id, now);
      if (changed.changes) {
        if (job.generation_id && status !== 'queued') db.prepare('UPDATE literature_index_generations SET status=? WHERE id=? AND status IN (\'queued\',\'building\')')
          .run(unknown ? 'partial' : 'failed', job.generation_id);
        event(String(job.id), status === 'queued' ? 'requeued' : status, unknown
          ? '租约到期时模型请求用量未知，任务停止并保留已完成结果' : status === 'queued' ? '租约到期，任务重新排队' : '任务达到最大尝试次数，停止重试',
          { attempt: Number(job.attempt_count), maxAttempts: Number(job.max_attempts), unknownRequests: pending });
      }
    }
  });
}

function claimJob() {
  const now = Date.now();
  expireLeases(now);
  return transaction(() => {
    const parse = db.prepare(`SELECT j.* FROM literature_jobs j LEFT JOIN literature_items i ON i.id=j.item_id
      WHERE j.job_type='parse' AND j.status='queued' AND j.cancel_requested=0 AND COALESCE(j.lease_until_ms,0)<=?
        AND (j.item_id IS NULL OR i.deleted_at IS NULL) ORDER BY j.created_at,j.id LIMIT 1`).get(now) as Row | undefined;
    const vectorReady = getLiteratureEmbeddingStatus().qdrant.configured && Boolean(getActiveLiteratureProfile());
    const candidate = parse || (vectorReady ? db.prepare(`SELECT j.* FROM literature_jobs j LEFT JOIN literature_items i ON i.id=j.item_id
      WHERE j.job_type IN ('index','rebuild') AND j.status IN ('queued','waiting_configuration') AND j.cancel_requested=0
        AND COALESCE(j.lease_until_ms,0)<=? AND (j.item_id IS NULL OR i.deleted_at IS NULL) ORDER BY j.created_at,j.id LIMIT 1`).get(now) as Row | undefined : undefined);
    if (!candidate) return undefined;
    const leaseOwner = `${WORKER_ID}_${randomUUID()}`;
    const nextStatus = candidate.job_type === 'parse' ? 'parsing' : 'embedding';
    const result = db.prepare(`UPDATE literature_jobs SET status=?,lease_owner=?,lease_until_ms=?,attempt_count=attempt_count+1,
      started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now'),progress_json=?
      WHERE id=? AND status=? AND cancel_requested=0`)
      .run(nextStatus, leaseOwner, now + LEASE_MS, JSON.stringify({ stage: nextStatus, message: candidate.job_type === 'parse' ? '文献本地解析已启动' : '文献向量索引已启动' }), candidate.id, candidate.status);
    if (!result.changes) return undefined;
    event(String(candidate.id), 'claimed', candidate.job_type === 'parse' ? '文献 Worker 已领取本地解析任务' : '文献 Worker 已领取向量索引任务',
      { workerId: WORKER_ID, attempt: Number(candidate.attempt_count) + 1 });
    return { ...candidate, lease_owner: leaseOwner, attempt_count: Number(candidate.attempt_count) + 1 } as Row;
  });
}

function currentLease(job: Row) {
  const row = db.prepare(`SELECT j.*,i.deleted_at,i.current_version_id,v.storage_key,v.sha256 AS file_sha256,v.original_name,v.extension
    FROM literature_jobs j LEFT JOIN literature_items i ON i.id=j.item_id
    LEFT JOIN literature_file_versions v ON v.id=j.version_id WHERE j.id=?`).get(job.id) as Row | undefined;
  const allowedStatuses = job.job_type === 'parse' ? ['parsing'] : ['embedding','publishing'];
  return Boolean(row && allowedStatuses.includes(String(row.status)) && row.lease_owner === job.lease_owner && Number(row.attempt_count) === Number(job.attempt_count)
    && Number(row.lease_until_ms) > Date.now() && Number(row.cancel_requested) === 0 && row.deleted_at === null
    && row.current_version_id === row.version_id && row.file_sha256 && row.file_sha256 === job.configSnapshot?.fileSha256);
}

function cancelled(job: Row) {
  const row = db.prepare('SELECT status,cancel_requested FROM literature_jobs WHERE id=?').get(job.id) as Row | undefined;
  return !row || row.status === 'cancelled' || Number(row.cancel_requested) === 1;
}

function renewLease(job: Row, progress: Row) {
  const now = Date.now();
  const changed = db.prepare(`UPDATE literature_jobs SET lease_until_ms=?,updated_at=datetime('now'),progress_json=?
    WHERE id=? AND status IN ('parsing','embedding','publishing') AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
    .run(now + LEASE_MS, JSON.stringify(progress), job.id, job.lease_owner, job.attempt_count, now);
  return changed.changes > 0;
}

function finishWithoutParse(job: Row, status: string, message: string, errorCode: string | null = null) {
  transaction(() => {
    const changed = db.prepare(`UPDATE literature_jobs SET status=?,finished_at=datetime('now'),lease_owner=NULL,lease_until_ms=NULL,
      updated_at=datetime('now'),error_code=?,error_message=?,progress_json=?
      WHERE id=? AND status='parsing' AND lease_owner=? AND attempt_count=? AND lease_until_ms>?`)
      .run(status, errorCode, message, JSON.stringify({ stage: status, message }), job.id, job.lease_owner, job.attempt_count, Date.now());
    if (changed.changes) event(String(job.id), status, message);
  });
}

function persistExtraction(job: Row, version: Row, parsed: Awaited<ReturnType<typeof parseLiteratureFile>>) {
  return transaction(() => {
    const now = Date.now();
    const valid = db.prepare(`SELECT j.id FROM literature_jobs j JOIN literature_items i ON i.id=j.item_id
      WHERE j.id=? AND j.status='parsing' AND j.lease_owner=? AND j.attempt_count=? AND j.lease_until_ms>?
        AND j.cancel_requested=0 AND i.deleted_at IS NULL AND i.current_version_id=j.version_id`)
      .get(job.id, job.lease_owner, job.attempt_count, now);
    if (!valid) return false;
    const existing = db.prepare(`SELECT id FROM literature_extractions WHERE version_id=? AND input_sha256=? AND parser_version=?`)
      .get(job.version_id, version.file_sha256, LITERATURE_PARSER_VERSION) as Row | undefined;
    let extractionId: string;
    if (existing) extractionId = String(existing.id);
    else {
      extractionId = id('litext_');
      db.prepare(`INSERT INTO literature_extractions(id,item_id,version_id,input_sha256,parser_version,status,coverage_json,page_count,pages_read,text_length,error_message)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(extractionId, job.item_id, job.version_id, version.file_sha256, LITERATURE_PARSER_VERSION,
        parsed.status, JSON.stringify(parsed.coverage), parsed.pageCount, parsed.pagesRead, parsed.textLength,
        parsed.status === 'needs_ocr' ? 'PDF 没有可提取文本层，需要 OCR。' : parsed.status === 'partial' ? String(parsed.coverage.omittedReason || '文件仅部分解析，请检查覆盖信息。') : '');
      const insert = db.prepare(`INSERT INTO literature_chunks(id,item_id,version_id,extraction_id,sequence_no,source_extent,locator_json,section_title,content_text,content_sha256)
        VALUES (?,?,?, ?,?,'full_text',?,?,?,?)`);
      parsed.chunks.forEach((chunk, sequenceNo) => insert.run(id('lch_'), job.item_id, job.version_id, extractionId, sequenceNo,
        JSON.stringify(chunk.locator), chunk.sectionTitle, chunk.text, sha256(chunk.text)));
    }
    const terminal = parsed.status === 'parsed' ? 'completed' : parsed.status === 'unsupported' ? 'partial' : 'partial';
    const message = parsed.status === 'needs_ocr' ? '文本层解析完成，扫描内容待 OCR' : parsed.status === 'partial'
      ? '文献部分解析完成，覆盖范围和省略原因已记录' : parsed.status === 'unsupported' ? '文件保留，当前格式没有本地解析器' : '本地解析完成';
    const updated = db.prepare(`UPDATE literature_jobs SET status=?,finished_at=datetime('now'),lease_owner=NULL,lease_until_ms=NULL,
      updated_at=datetime('now'),error_code=NULL,error_message='',progress_json=?
      WHERE id=? AND status='parsing' AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
      .run(terminal, JSON.stringify({ stage: terminal, message, extractionId, parseStatus: parsed.status,
        pageCount: parsed.pageCount, pagesRead: parsed.pagesRead, chunkCount: parsed.chunks.length, textLength: parsed.textLength }),
      job.id, job.lease_owner, job.attempt_count, now);
    if (!updated.changes) return false;
    event(String(job.id), terminal, message, { extractionId, parseStatus: parsed.status, pageCount: parsed.pageCount,
      pagesRead: parsed.pagesRead, chunkCount: parsed.chunks.length, textLength: parsed.textLength, coverage: parsed.coverage });
    return true;
  });
}

function currentIndexLease(job: Row) {
  const row = db.prepare(`SELECT j.*,i.deleted_at,i.current_version_id,p.active AS profile_active FROM literature_jobs j
    JOIN literature_items i ON i.id=j.item_id JOIN literature_embedding_profiles p ON p.id=j.profile_id WHERE j.id=?`)
    .get(job.id) as Row | undefined;
  return Boolean(row && ['embedding','publishing'].includes(String(row.status)) && row.lease_owner === job.lease_owner
    && Number(row.attempt_count) === Number(job.attempt_count) && Number(row.lease_until_ms) > Date.now()
    && Number(row.cancel_requested) === 0 && row.deleted_at === null && row.current_version_id === row.version_id && Number(row.profile_active) === 1);
}

function logLeasedIndexEvent(job: Row, eventType: string, message: string, metadata: Row = {}) {
  if (!currentIndexLease(job)) return false;
  event(String(job.id), eventType, message, metadata);
  return true;
}

function updateIndexStage(job: Row, status: 'embedding' | 'publishing', progress: Row, message: string) {
  const now = Date.now();
  const changed = db.prepare(`UPDATE literature_jobs SET status=?,progress_json=?,updated_at=datetime('now'),lease_until_ms=?
    WHERE id=? AND status IN ('embedding','publishing') AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
    .run(status, JSON.stringify(progress), now + LEASE_MS, job.id, job.lease_owner, job.attempt_count, now);
  if (!changed.changes) return false;
  event(String(job.id), status, message, progress);
  return true;
}

function indexProgress(job: Row, stage: string, message: string, metadata: Row = {}) {
  return updateIndexStage(job, 'embedding', { stage, message, ...metadata }, message);
}

function finishIndexJob(job: Row, status: 'completed' | 'partial' | 'failed' | 'superseded' | 'cancelled', message: string,
  errorCode: string | null = null, extra: Row = {}) {
  return transaction(() => {
    const now = Date.now();
    const updated = db.prepare(`UPDATE literature_jobs SET status=?,finished_at=datetime('now'),lease_owner=NULL,lease_until_ms=NULL,
      updated_at=datetime('now'),error_code=?,error_message=?,progress_json=?
      WHERE id=? AND status IN ('embedding','publishing') AND lease_owner=? AND attempt_count=? AND lease_until_ms>?`)
      .run(status, errorCode, status === 'completed' ? '' : message.slice(0, 1000), JSON.stringify({ stage: status, message, ...extra }),
        job.id, job.lease_owner, job.attempt_count, now);
    if (!updated.changes) return false;
    if (job.generation_id) {
      const generationStatus = status === 'completed' ? 'ready' : status === 'superseded' ? 'stale' : status === 'cancelled' ? 'cancelled' : status;
      db.prepare(`UPDATE literature_index_generations SET status=?,indexed_count=COALESCE(?,indexed_count),published_at=CASE WHEN ?='ready' THEN datetime('now') ELSE published_at END
        WHERE id=? AND status IN ('queued','building','partial')`)
        .run(generationStatus, extra.indexedCount ?? null, generationStatus, job.generation_id);
      if (status === 'completed') db.prepare(`UPDATE literature_index_generations SET status='stale' WHERE item_id=? AND profile_id=? AND id<>?
        AND status='ready'`).run(job.item_id, job.profile_id, job.generation_id);
    }
    event(String(job.id), status, message, extra);
    return true;
  });
}

function deferIndexJobForMissingEmbeddingKey(job: Row) {
  return transaction(() => {
    const now = Date.now();
    const changed = db.prepare(`UPDATE literature_jobs SET status='waiting_configuration',attempt_count=MAX(0,attempt_count-1),
      finished_at=NULL,lease_owner=NULL,lease_until_ms=NULL,updated_at=datetime('now'),error_code='embedding_key_required',
      error_message='当前向量缓存不完整；配置服务端 Embedding 密钥后即可继续。',
      progress_json=? WHERE id=? AND status='embedding' AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
      .run(JSON.stringify({ stage: 'waiting_configuration', message: '完整向量缓存缺少部分片段；已等待服务端 Embedding 密钥，未发出模型请求。' }),
        job.id, job.lease_owner, job.attempt_count, now);
    if (!changed.changes) return false;
    db.prepare("UPDATE literature_index_generations SET status='queued' WHERE id=? AND status IN ('queued','building')").run(job.generation_id);
    event(String(job.id), 'waiting_configuration', '本地缓存不完整；等待服务端 Embedding 密钥，不消耗任务尝试次数。',
      { missingEmbeddingKey: true, attemptCount: Math.max(0, Number(job.attempt_count) - 1) });
    return true;
  });
}

function updateUsageForRequest(job: Row, result: { promptTokens: number | null; totalTokens: number | null; responseId: string; status: 'known' | 'unknown' }) {
  return transaction(() => {
    const now = Date.now();
    const fresh = db.prepare(`SELECT usage_tokens,usage_pending_count,usage_unknown_count FROM literature_jobs
      WHERE id=? AND status='embedding' AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
      .get(job.id, job.lease_owner, job.attempt_count, now) as Row | undefined;
    if (!fresh) return false;
    const unknown = result.status === 'unknown';
    db.prepare(`UPDATE literature_jobs SET usage_pending_count=MAX(0,usage_pending_count-1),
      usage_tokens=usage_tokens+?,usage_unknown_count=usage_unknown_count+?,
      usage_status=?,usage_stop_reason=?,usage_last_response_id=?,updated_at=datetime('now')
      WHERE id=? AND status='embedding' AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
      .run(unknown ? 0 : Number(result.totalTokens || 0), unknown ? 1 : 0,
        unknown ? Number(fresh.usage_tokens) > 0 ? 'partial_unknown' : 'unknown' : 'known',
        unknown ? 'embedding_usage_missing_or_invalid' : '', result.responseId.slice(0, 200),
        job.id, job.lease_owner, job.attempt_count, now);
    if (unknown) event(String(job.id), 'token_usage_unknown', 'Embedding 响应缺少可核验用量；已停止后续模型请求。',
      { requests: 1, knownTokens: Number(fresh.usage_tokens), responseId: result.responseId || '' });
    else event(String(job.id), 'usage_recorded', 'Embedding 服务报告的 prompt token 用量已累计。',
      { promptTokens: result.promptTokens, totalTokens: result.totalTokens, responseId: result.responseId || '' });
    return true;
  });
}

function beginEmbeddingRequest(job: Row) {
  return transaction(() => {
    const now = Date.now();
    const fresh = db.prepare(`SELECT * FROM literature_jobs WHERE id=? AND status='embedding' AND lease_owner=? AND attempt_count=?
      AND lease_until_ms>? AND cancel_requested=0`).get(job.id, job.lease_owner, job.attempt_count, now) as Row | undefined;
    if (!fresh) return { ok: false as const, reason: 'stale_lease' };
    if (['unknown','partial_unknown'].includes(String(fresh.usage_status)) || Number(fresh.usage_unknown_count) > 0) return { ok: false as const, reason: 'usage_unknown' };
    if (Number(fresh.usage_request_count) >= Number(fresh.budget_requests)) return { ok: false as const, reason: 'request_budget' };
    if (Number(fresh.usage_tokens) >= Number(fresh.budget_tokens)) return { ok: false as const, reason: 'token_budget' };
    db.prepare(`UPDATE literature_jobs SET usage_pending_count=usage_pending_count+1,usage_request_count=usage_request_count+1,
      updated_at=datetime('now') WHERE id=? AND status='embedding' AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
      .run(job.id, job.lease_owner, job.attempt_count, now);
    event(String(job.id), 'embedding_request_started', '已登记一次待结算 Embedding 请求。',
      { requestCount: Number(fresh.usage_request_count) + 1, requestBudget: Number(fresh.budget_requests) });
    return { ok: true as const, usageTokens: Number(fresh.usage_tokens), usageRequestCount: Number(fresh.usage_request_count) + 1 };
  });
}

function finishRejectedEmbeddingRequest(job: Row, code: string, message: string) {
  return transaction(() => {
    const now = Date.now();
    const changed = db.prepare(`UPDATE literature_jobs SET usage_pending_count=MAX(0,usage_pending_count-1),error_code=?,error_message=?,updated_at=datetime('now')
      WHERE id=? AND status='embedding' AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
      .run(code, message.slice(0, 500), job.id, job.lease_owner, job.attempt_count, now);
    if (!changed.changes) return false;
    event(String(job.id), 'request_rejected', 'Embedding 服务明确拒绝本次请求；未记录推测 token。', { errorCode: code });
    return true;
  });
}

function cacheEmbeddingBatch(job: Row, profileId: string, chunks: Row[], inputs: string[], vectors: number[][], usageStatus: 'known' | 'unknown', tokens: number | null, responseId: string) {
  return transaction(() => {
    if (!currentIndexLease(job)) return false;
    const insert = db.prepare(`INSERT INTO literature_embedding_cache(id,chunk_id,profile_id,input_sha256,dimensions,vector_blob,vector_sha256,usage_tokens,usage_status,response_id)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chunk_id,profile_id,input_sha256) DO NOTHING`);
    for (let index = 0; index < chunks.length; index++) {
      const floats = Float32Array.from(vectors[index]);
      const blob = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
      insert.run(id('lemb_'), chunks[index].id, profileId, sha256(inputs[index]), vectors[index].length, blob, sha256(blob),
        usageStatus === 'known' ? tokens : null, usageStatus, responseId);
    }
    return true;
  });
}

function readCachedEmbedding(chunkId: string, profileId: string, inputSha: string, dimensions: number) {
  const row = db.prepare(`SELECT * FROM literature_embedding_cache WHERE chunk_id=? AND profile_id=? AND input_sha256=?`)
    .get(chunkId, profileId, inputSha) as Row | undefined;
  if (!row) return undefined;
  const blob = Buffer.from(row.vector_blob as Uint8Array);
  if (Number(row.dimensions) !== dimensions || blob.byteLength !== dimensions * 4 || sha256(blob) !== row.vector_sha256) {
    throw Object.assign(new Error('SQLite Embedding 缓存维度或 SHA 校验失败'), { code: 'embedding_cache_corrupt' });
  }
  const floats = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  const vector = Array.from(floats);
  if (!vector.some(value => value !== 0) || vector.some(value => !Number.isFinite(value))) throw Object.assign(new Error('SQLite Embedding 缓存包含零值或非法数值'), { code: 'embedding_cache_corrupt' });
  return vector;
}

function scheduleIndexRetry(job: Row, error: EmbeddingRequestError) {
  if (!error.retryable || Number(job.attempt_count) >= Number(job.max_attempts)) return false;
  const delayMs = Math.min(10_000, 500 * 2 ** Math.max(0, Number(job.attempt_count) - 1));
  return transaction(() => {
    const now = Date.now();
    const changed = db.prepare(`UPDATE literature_jobs SET status='queued',lease_owner=NULL,lease_until_ms=?,updated_at=datetime('now'),
      error_code=?,error_message=?,progress_json=? WHERE id=? AND status='embedding' AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
      .run(now + delayMs, error.code, error.message, JSON.stringify({ stage: 'retry', message: '已按有限退避重新排队', retryAfterMs: delayMs, errorCode: error.code }),
        job.id, job.lease_owner, job.attempt_count, now);
    if (!changed.changes) return false;
    event(String(job.id), 'retry', 'Embedding 限流后按有限退避重新排队；已知任务累计用量保留。',
      { attempt: job.attempt_count, maxAttempts: job.max_attempts, retryAfterMs: delayMs, requestCount: job.usage_request_count });
    return true;
  });
}

function markIndexGenerationBuilding(job: Row) {
  return transaction(() => {
    if (!currentIndexLease(job)) return false;
    db.prepare("UPDATE literature_index_generations SET status='building' WHERE id=? AND status IN ('queued','building')").run(job.generation_id);
    return true;
  });
}

function persistIndexedCount(job: Row, count: number, total: number, stage: string, message: string) {
  return transaction(() => {
    if (!currentIndexLease(job)) return false;
    db.prepare(`UPDATE literature_index_generations SET indexed_count=? WHERE id=? AND status='building'`).run(count, job.generation_id);
    const progress = { stage, message, indexedChunks: count, totalChunks: total, percent: total ? Math.floor(count / total * 100) : 100 };
    const now = Date.now();
    const changed = db.prepare(`UPDATE literature_jobs SET progress_json=?,lease_until_ms=?,updated_at=datetime('now')
      WHERE id=? AND status IN ('embedding','publishing') AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
      .run(JSON.stringify(progress), now + LEASE_MS, job.id, job.lease_owner, job.attempt_count, now);
    if (!changed.changes) return false;
    event(String(job.id), stage, message, progress);
    return true;
  });
}

async function processIndexJob(job: Row) {
  const source = db.prepare(`SELECT j.*,i.deleted_at AS item_deleted_at,i.current_version_id AS item_current_version_id,i.revision AS item_revision,
      v.sha256 AS file_sha256,p.fingerprint AS profile_fingerprint,p.model AS profile_model,p.dimensions AS profile_dimensions,
      p.distance AS profile_distance,p.document_prefix,p.query_prefix,p.send_dimensions,p.active AS profile_active,
      p.generation AS profile_generation,g.collection_name,g.manifest_sha256,g.generation_no,g.status AS generation_status
    FROM literature_jobs j JOIN literature_items i ON i.id=j.item_id LEFT JOIN literature_file_versions v ON v.id=j.version_id
    JOIN literature_embedding_profiles p ON p.id=j.profile_id JOIN literature_index_generations g ON g.id=j.generation_id WHERE j.id=?`).get(job.id) as Row | undefined;
  if (!source || source.item_deleted_at || source.item_current_version_id !== source.version_id || Number(source.profile_active) !== 1
    || !currentIndexLease(job)) { finishIndexJob(job, 'superseded', '文献版本、删除状态或活动 profile 已变化；旧索引不发布。', 'source_stale'); return; }
  const active = getActiveLiteratureProfile();
  if (!active || active.id !== source.profile_id) { finishIndexJob(job, 'superseded', 'Embedding profile 已切换；此代索引停止。', 'profile_stale'); return; }
  const snapshot = JSON.parse(String(source.config_snapshot_json || '{}'));
  if (snapshot.profileFingerprint !== source.profile_fingerprint || snapshot.model !== source.profile_model || Number(snapshot.dimensions) !== Number(source.profile_dimensions)) {
    finishIndexJob(job, 'failed', '任务 profile 快照与数据库 profile 不一致。', 'profile_snapshot_mismatch'); return;
  }
  const extraction = source.version_id ? db.prepare(`SELECT id,status FROM literature_extractions WHERE version_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`)
    .get(source.version_id) as Row | undefined : undefined;
  const chunks = db.prepare(`SELECT id,item_id,version_id,source_extent,locator_json,section_title,content_text,content_sha256
    FROM literature_chunks WHERE item_id=? AND (source_extent IN ('metadata','abstract') AND extraction_id IS NULL AND metadata_revision=? OR extraction_id=?)
    ORDER BY source_extent,sequence_no`).all(source.item_id, source.item_revision, extraction?.id || '') as Row[];
  const manifest = chunks.map(chunk => `${chunk.id}:${chunk.content_sha256}`).join('\n');
  const fingerprint = sha256(`${source.version_id || 'metadata'}\0${source.profile_fingerprint}\0${manifest}`);
  if (fingerprint !== source.manifest_sha256 || !chunks.length) { finishIndexJob(job, 'superseded', '文献全文或检索片段已更新，索引manifest不再匹配。', 'manifest_stale'); return; }
  const config = getLiteratureEmbeddingConfig();
  const profile = { baseUrl: String(source.endpoint_url || snapshot.endpointUrl), model: String(source.profile_model),
    dimensions: Number(source.profile_dimensions), distance: String(source.profile_distance) as any,
    sendDimensions: Number(source.send_dimensions) === 1, maxInputChars: Number(snapshot.maxInputChars || config.maxInputChars), timeoutMs: Number(snapshot.timeoutMs || config.timeoutMs) };
  const batchSize = Math.max(1, Math.min(64, Number(snapshot.batchSize || config.batchSize)));
  const vectors: Array<number[] | undefined> = Array(chunks.length);
  const inputTexts = chunks.map(chunk => `${String(source.document_prefix || '')}${String(chunk.content_text)}`);
  const inputHashes = inputTexts.map(text => sha256(text));
  let cachedCount = 0;
  const missing: number[] = [];
  try {
    for (let index = 0; index < chunks.length; index++) {
      if (!currentIndexLease(job)) return;
      const cached = readCachedEmbedding(String(chunks[index].id), String(source.profile_id), inputHashes[index], profile.dimensions);
      if (cached) { vectors[index] = cached; cachedCount++; } else missing.push(index);
    }
  } catch (error) { finishIndexJob(job, 'failed', (error as Error).message, 'embedding_cache_corrupt'); return; }
  if (missing.length && !String(process.env.IVD_EMBEDDING_API_KEY || '').trim()) {
    deferIndexJobForMissingEmbeddingKey(job);
    return;
  }
  try {
    await ensureLiteratureCollection(String(source.collection_name), Number(source.profile_dimensions), String(source.profile_distance));
  } catch (error) {
    const code = String((error as any)?.code || 'qdrant_unavailable');
    finishIndexJob(job, 'failed', (error as Error).message, code);
    return;
  }
  if (!markIndexGenerationBuilding(job)) return;
  if (!indexProgress(job, 'embedding', '正在检查缓存并生成文献向量', { cachedChunks: cachedCount, chunksToEmbed: missing.length, totalChunks: chunks.length })) return;
  let upserted = 0;
  try {
    const cachedPoints = chunks.map((chunk, index) => vectors[index] ? ({
      id: deterministicPointId(String(source.profile_id), String(chunk.id), String(job.generation_id)), vector: vectors[index]!,
      payload: { item_id: source.item_id, version_id: source.version_id || '', chunk_id: chunk.id, profile_id: source.profile_id,
        generation_id: job.generation_id, content_sha256: chunk.content_sha256, source_extent: chunk.source_extent },
    }) : null).filter(Boolean) as Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>;
    if (cachedPoints.length) {
      await upsertLiteraturePoints(String(source.collection_name), profile.dimensions, profile.distance, cachedPoints);
      upserted = cachedPoints.length;
      if (!persistIndexedCount(job, upserted, chunks.length, 'embedding', `已从本地向量缓存恢复 ${upserted}/${chunks.length} 个片段`)) return;
    }
  } catch (error) { finishIndexJob(job, 'failed', (error as Error).message.slice(0, 500), 'qdrant_unavailable', { indexedCount: upserted, chunkCount: chunks.length }); return; }
  for (let offset = 0; offset < missing.length; offset += batchSize) {
    if (!currentIndexLease(job)) return;
    const batchIndexes = missing.slice(offset, offset + batchSize);
    const begin = beginEmbeddingRequest(job);
    if (!begin.ok) {
      const reason = begin.reason;
      finishIndexJob(job, 'partial', reason === 'usage_unknown' ? '已有请求用量未知，后续模型请求已停止。' :
        reason === 'request_budget' ? '达到任务最大 Embedding 请求数，剩余片段待处理。' : reason === 'token_budget' ? '达到任务累计 token 预算，剩余片段待处理。' : '任务租约已失效。',
      reason === 'usage_unknown' ? 'usage_unknown' : reason === 'request_budget' ? 'request_budget' : reason === 'token_budget' ? 'token_budget' : 'stale_lease',
      { indexedCount: upserted, chunkCount: chunks.length, cachedCount });
      return;
    }
    const batchChunks = batchIndexes.map(index => chunks[index]);
    const batchInputs = batchIndexes.map(index => inputTexts[index]);
    let embedded;
    try { embedded = await embedOpenAiCompatible(batchInputs, profile); }
    catch (error) {
      const failure = error instanceof EmbeddingRequestError ? error : new EmbeddingRequestError('Embedding 请求失败；用量状态未知。', 'embedding_unknown', false, 'unknown');
      if (failure.usageOutcome === 'unknown') {
        transaction(() => {
          const now = Date.now();
          const current = db.prepare(`SELECT usage_tokens FROM literature_jobs WHERE id=? AND status='embedding' AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
            .get(job.id, job.lease_owner, job.attempt_count, now) as Row | undefined;
          if (!current) return;
          db.prepare(`UPDATE literature_jobs SET usage_pending_count=MAX(0,usage_pending_count-1),usage_unknown_count=usage_unknown_count+1,
            usage_status=?,usage_stop_reason=?,error_code=?,error_message=?,updated_at=datetime('now') WHERE id=? AND status='embedding' AND lease_owner=? AND attempt_count=? AND lease_until_ms>?`)
            .run(Number(current.usage_tokens) > 0 ? 'partial_unknown' : 'unknown', failure.code, failure.code, failure.message,
              job.id, job.lease_owner, job.attempt_count, now);
          event(String(job.id), 'token_usage_unknown', 'Embedding 请求已发出但无法确认用量；后续请求停止。', { errorCode: failure.code });
        });
        finishIndexJob(job, 'partial', failure.message, failure.code, { indexedCount: upserted, chunkCount: chunks.length });
      } else {
        finishRejectedEmbeddingRequest(job, failure.code, failure.message);
        if (!scheduleIndexRetry(job, failure)) finishIndexJob(job, 'failed', failure.message, failure.code, { indexedCount: upserted, chunkCount: chunks.length });
      }
      return;
    }
    if (!updateUsageForRequest(job, embedded.usage)) return;
    if (embedded.model && embedded.model !== profile.model) {
      finishIndexJob(job, 'failed', `Embedding 响应模型与 profile 不同：${embedded.model}`, 'embedding_model_mismatch'); return;
    }
    if (!cacheEmbeddingBatch(job, String(source.profile_id), batchChunks, batchInputs, embedded.vectors, embedded.usage.status,
      embedded.usage.totalTokens, embedded.usage.responseId)) return;
    batchIndexes.forEach((index, vectorIndex) => vectors[index] = embedded.vectors[vectorIndex]);
    if (embedded.usage.status === 'unknown') {
      // These valid vectors can be kept and published only after all expected vectors exist; the unknown task is stopped below.
      try {
      const points = batchIndexes.map((index, vectorIndex) => ({ id: deterministicPointId(String(source.profile_id), String(chunks[index].id), String(job.generation_id)),
          vector: embedded.vectors[vectorIndex], payload: { item_id: source.item_id, version_id: source.version_id || '', chunk_id: chunks[index].id,
            profile_id: source.profile_id, generation_id: job.generation_id, content_sha256: chunks[index].content_sha256, source_extent: chunks[index].source_extent } }));
        await upsertLiteraturePoints(String(source.collection_name), profile.dimensions, profile.distance, points);
        upserted += batchIndexes.length;
        persistIndexedCount(job, upserted, chunks.length, 'partial', '用量未知的当前批次已缓存并写入未发布代索引');
      } catch (error) { finishIndexJob(job, 'partial', (error as Error).message, 'qdrant_partial_unknown', { indexedCount: upserted, chunkCount: chunks.length }); return; }
      finishIndexJob(job, 'partial', 'Embedding 服务未提供可核验用量；当前向量已保存，后续请求与发布均已停止。', 'usage_unknown', { indexedCount: upserted, chunkCount: chunks.length });
      return;
    }
    try {
      const points = batchIndexes.map((index, vectorIndex) => ({ id: deterministicPointId(String(source.profile_id), String(chunks[index].id), String(job.generation_id)),
        vector: embedded.vectors[vectorIndex], payload: { item_id: source.item_id, version_id: source.version_id || '', chunk_id: chunks[index].id,
          profile_id: source.profile_id, generation_id: job.generation_id, content_sha256: chunks[index].content_sha256, source_extent: chunks[index].source_extent } }));
      await upsertLiteraturePoints(String(source.collection_name), profile.dimensions, profile.distance, points);
      upserted += batchIndexes.length;
      if (!persistIndexedCount(job, upserted, chunks.length, 'embedding', `已完成 ${Math.min(upserted, chunks.length)}/${chunks.length} 个片段`)) return;
    } catch (error) { finishIndexJob(job, 'failed', (error as Error).message.slice(0, 500), 'qdrant_unavailable', { indexedCount: upserted, chunkCount: chunks.length }); return; }
    const freshUsage = db.prepare('SELECT usage_tokens,usage_unknown_count FROM literature_jobs WHERE id=?').get(job.id) as Row;
    if (Number(freshUsage.usage_tokens) > Number(job.budget_tokens)) {
      finishIndexJob(job, 'partial', '当前 Embedding 请求的实际用量超过任务预算；已停止后续请求。', 'token_budget_exceeded', { indexedCount: upserted, chunkCount: chunks.length }); return;
    }
  }
  const finalCount = upserted;
  if (finalCount !== chunks.length) { finishIndexJob(job, 'partial', '索引片段数与预期不一致，未发布此代索引。', 'index_count_mismatch', { indexedCount: finalCount, chunkCount: chunks.length }); return; }
  if (!currentIndexLease(job)) return;
  const live = db.prepare('SELECT deleted_at,current_version_id FROM literature_items WHERE id=?').get(job.item_id) as Row | undefined;
  const latestProfile = getActiveLiteratureProfile();
  if (!live || live.deleted_at || live.current_version_id !== job.version_id || !latestProfile || latestProfile.id !== job.profile_id) {
    finishIndexJob(job, 'superseded', '索引发布前文献或 profile 已更新；当前 generation 不发布。', 'source_stale', { indexedCount: finalCount }); return;
  }
  const published = transaction(() => {
    const now = Date.now();
    const valid = db.prepare(`SELECT id FROM literature_jobs WHERE id=? AND status IN ('embedding','publishing') AND lease_owner=? AND attempt_count=?
      AND lease_until_ms>? AND cancel_requested=0`).get(job.id, job.lease_owner, job.attempt_count, now);
    const item = db.prepare('SELECT deleted_at,current_version_id FROM literature_items WHERE id=?').get(job.item_id) as Row | undefined;
    const profileNow = getActiveLiteratureProfile();
    if (!valid || !item || item.deleted_at || item.current_version_id !== job.version_id || profileNow?.id !== job.profile_id) return false;
    db.prepare(`UPDATE literature_index_generations SET status='ready',indexed_count=?,published_at=datetime('now') WHERE id=? AND status='building'`)
      .run(finalCount, job.generation_id);
    db.prepare(`UPDATE literature_index_generations SET status='stale' WHERE item_id=? AND profile_id=? AND id<>? AND status='ready'`)
      .run(job.item_id, job.profile_id, job.generation_id);
    const done = db.prepare(`UPDATE literature_jobs SET status='completed',finished_at=datetime('now'),lease_owner=NULL,lease_until_ms=NULL,
      updated_at=datetime('now'),error_code=NULL,error_message='',progress_json=? WHERE id=? AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
      .run(JSON.stringify({ stage: 'completed', message: `已索引 ${finalCount} 个文献片段`, indexedChunks: finalCount, totalChunks: chunks.length,
        collection: source.collection_name, profile: source.profile_model }), job.id, job.lease_owner, job.attempt_count, now);
    if (!done.changes) return false;
    event(String(job.id), 'completed', '文献向量索引完整发布。', { generationId: job.generation_id, indexedChunks: finalCount, totalChunks: chunks.length,
      profileId: job.profile_id, model: source.profile_model, dimensions: source.profile_dimensions });
    return true;
  });
  if (!published) return;
  heartbeat('idle', null, { lastJobId: job.id, outcome: 'indexed' });
}

async function processJob(job: Row) {
  const source = db.prepare(`SELECT j.*,v.storage_key,v.sha256 AS file_sha256,v.original_name,v.extension,i.deleted_at,i.current_version_id
    FROM literature_jobs j JOIN literature_file_versions v ON v.id=j.version_id JOIN literature_items i ON i.id=j.item_id WHERE j.id=?`).get(job.id) as Row | undefined;
  if (!source || source.deleted_at || source.current_version_id !== source.version_id) {
    finishWithoutParse(job, source?.deleted_at ? 'cancelled' : 'superseded', '文献已删除或全文版本已更新，旧任务不发布解析结果', 'source_stale'); return;
  }
  const target = safeLiteraturePath(String(source.storage_key));
  if (!target || !existsSync(target)) { finishWithoutParse(job, 'failed', '文献原文件缺失或存储键无效', 'file_missing'); return; }
  const bytes = readFileSync(target);
  const digest = sha256(bytes);
  if (digest !== source.file_sha256 || digest !== JSON.parse(String(source.config_snapshot_json || '{}')).fileSha256) {
    finishWithoutParse(job, 'failed', '文献文件 SHA-256 与数据库记录不一致', 'file_hash_mismatch'); return;
  }
  if (!renewLease(job, { stage: 'parsing', message: '正在读取文献文件', fileName: source.original_name })) return;
  try {
    const parsed = await parseLiteratureFile(String(source.original_name), bytes, () => {
      if (cancelled(job)) return true;
      const leaseOk = renewLease(job, { stage: 'parsing', message: '正在逐页解析全文', fileName: source.original_name });
      return !leaseOk || !currentLease({ ...job, configSnapshot: { fileSha256: digest } });
    });
    if (!currentLease({ ...job, configSnapshot: { fileSha256: digest } })) return;
    const saved = persistExtraction(job, source, parsed);
    if (saved) {
      heartbeat('online', null, { lastJobId: job.id, outcome: parsed.status });
      const config = getLiteratureEmbeddingConfig();
      const profile = getActiveLiteratureProfile();
      if (config.autoIndex && profile) {
        const item = db.prepare('SELECT id,created_by FROM literature_items WHERE id=? AND deleted_at IS NULL').get(job.item_id) as Row | undefined;
        if (item) {
          try { enqueueLiteratureIndex({ id: String(item.created_by), role: 'RESEARCHER' }, item); }
          catch (indexError) { console.warn('Automatic literature indexing was not queued:', (indexError as Error).message.slice(0, 250)); }
        }
      }
    }
  } catch (error) {
    console.error('Literature parse task failed:', error instanceof Error ? error.stack : String(error));
    if ((error as any)?.code === 'CANCELLED' || cancelled(job)) {
      finishWithoutParse(job, 'cancelled', '文献解析任务已取消'); return;
    }
    if (!currentLease({ ...job, configSnapshot: { fileSha256: digest } })) return;
    finishWithoutParse(job, 'failed', (error as Error).message.slice(0, 1000), 'parse_failed');
  }
}

export async function runLiteratureWorkerOnce() {
  heartbeat('online');
  const job = claimJob();
  if (!job) { heartbeat('idle'); return false; }
  heartbeat('busy', String(job.id));
  if (job.job_type === 'parse') await processJob(job);
  else await processIndexJob(job);
  heartbeat('idle');
  return true;
}

export async function runLiteratureWorker(signal?: AbortSignal, pollMs = 1_000) {
  heartbeat('online');
  while (!signal?.aborted) {
    try {
      const worked = await runLiteratureWorkerOnce();
      if (!worked) await new Promise(resolve => {
        const timer = setTimeout(resolve, pollMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
      });
    } catch (error) {
      heartbeat('error', null, { error: (error as Error).message.slice(0, 500) });
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs * 2, 10_000)));
    }
  }
  heartbeat('stopped');
}

export function getLiteratureWorkerStatus() {
  const heartbeatRow = db.prepare(`SELECT * FROM literature_worker_heartbeats WHERE last_seen_ms>? ORDER BY last_seen_ms DESC LIMIT 1`)
    .get(Date.now() - 30_000) as Row | undefined;
  return { online: Boolean(heartbeatRow), worker: heartbeatRow ? { ...heartbeatRow, detail: JSON.parse(heartbeatRow.detail_json) } : null,
    pendingJobs: Number((db.prepare("SELECT COUNT(*) AS n FROM literature_jobs WHERE job_type='parse' AND status='queued'").get() as Row).n) };
}
