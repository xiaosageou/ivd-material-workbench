import type { Express, NextFunction, Request, Response, RequestHandler } from 'express';
import multer from 'multer';
import { db } from '../db.ts';
import { getLiteratureWorkerStatus } from './worker.ts';
import {
  auditLiterature,
  collectionById, createCollection, createLiteratureRecord, deleteCollection, duplicateCandidates,
  getLiteratureDetails, getLiteratureStats, hash, listLiteratureCollections, listLiteratureRows,
  listDeletedLiterature,
  literatureById, mayEditLiterature, normalizeLiteratureInput, readLiteratureVersion,
  replaceLiteratureFile, safeLiteraturePath, setLiteratureDeleted, updateCollection, updateLiteratureMetadata,
  validateLiteratureFile, enqueueLiteratureIndex,
  type LiteratureActor, type UploadFile,
} from './repository.ts';
import { getLiteratureEmbeddingStatus, saveLiteratureEmbeddingConfig } from './embedding-config.ts';
import { embedOpenAiCompatible } from './embedding-provider.ts';
import { literatureVectorHealth } from './vector.ts';
import { searchLiterature } from './search.ts';

type Row = Record<string, any>;
type AuthRequest = Request & { user?: LiteratureActor };

const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8' });
const batchUpload = upload.array('files');
const versionUpload = upload.single('file');
const route = (handler: (req: AuthRequest, res: Response) => unknown | Promise<unknown>) => (req: AuthRequest, res: Response, next: NextFunction) => {
  try { Promise.resolve(handler(req, res)).catch(next); } catch (error) { next(error); }
};
const actor = (req: AuthRequest) => req.user as LiteratureActor;
const optional = (value: unknown) => String(value ?? '').trim();
const param = (req: Request, key: string) => String(req.params[key] ?? '');
const itemByIdIncludingDeleted = (itemId: string) => db.prepare('SELECT * FROM literature_items WHERE id=?').get(itemId) as Row | undefined;

function parseRecordList(value: unknown) {
  if (value === undefined || value === null || value === '') return [] as Row[];
  if (Array.isArray(value)) return value as Row[];
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) throw new Error('');
    return parsed as Row[];
  } catch { throw new Error('批量书目信息格式无效'); }
}

function actorCanEdit(req: AuthRequest, res: Response, item: Row | undefined) {
  if (!item || item.deleted_at) { res.status(404).json({ error: '文献不存在或已移入回收站' }); return false; }
  if (!mayEditLiterature(actor(req), item)) { res.status(403).json({ error: '仅文献上传者或管理员可编辑此文献' }); return false; }
  return true;
}

function uploadParser(parser: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    parser(req, res, error => {
      if (!error) return next();
      if (error instanceof multer.MulterError) return res.status(400).json({ error: '文献上传批次格式无效' });
      return next(error);
    });
  };
}

function collectionNameBody(req: AuthRequest) {
  return { name: optional(req.body?.name), description: optional(req.body?.description) };
}

export function installLiteratureRoutes(app: Express, requireAuth: RequestHandler, requireAdmin: RequestHandler) {
  app.get('/api/literature/worker/status', requireAuth, route((_req, res) => res.json(getLiteratureWorkerStatus())));
  app.get('/api/literature/search-status', requireAuth, route((req, res) => {
    const status = getLiteratureEmbeddingStatus();
    const profileId = status.profile?.id;
    const usage = profileId ? db.prepare('SELECT * FROM literature_query_usage WHERE owner_id=? AND profile_id=? AND usage_date=?')
      .get(actor(req).id, profileId, new Date().toISOString().slice(0, 10)) as Row | undefined : undefined;
    res.json({ embeddingReady: status.embedding.status === 'configured', vectorConfigured: status.qdrant.status === 'configured',
      workerOnline: getLiteratureWorkerStatus().online, profile: status.profile ? { model: status.profile.model, dimensions: status.profile.dimensions,
        distance: status.profile.distance } : null, missing: status.missing, queryUsage: usage ? { usedTokens: Number(usage.used_tokens), tokenBudget: Number(usage.token_budget),
          requestCount: Number(usage.request_count), requestBudget: Number(usage.request_budget), unknownCount: Number(usage.unknown_count), status: usage.usage_status,
          stopReason: usage.stop_reason } : { usedTokens: 0, tokenBudget: status.config.queryTokenBudget, requestCount: 0, requestBudget: status.config.queryMaxRequests,
          unknownCount: 0, status: 'none', stopReason: '' } });
  }));
  app.get('/api/admin/literature/embedding-config', requireAuth, requireAdmin, route((_req, res) => res.json(getLiteratureEmbeddingStatus())));
  app.patch('/api/admin/literature/embedding-config', requireAuth, requireAdmin, route((req, res) => {
    const body = req.body || {};
    const saved = saveLiteratureEmbeddingConfig(actor(req).id, body);
    db.prepare(`UPDATE literature_jobs SET status='queued',updated_at=datetime('now'),progress_json=?
      WHERE job_type IN ('index','rebuild') AND status='waiting_configuration' AND cancel_requested=0`)
      .run(JSON.stringify({ stage: 'queued', message: '向量化配置已保存，任务重新排队' }));
    if (saved.profile) {
      const waiting = db.prepare(`SELECT i.* FROM literature_items i
        WHERE i.deleted_at IS NULL AND (i.current_version_id IS NULL OR EXISTS
          (SELECT 1 FROM literature_extractions e WHERE e.version_id=i.current_version_id AND e.status NOT IN ('failed','unsupported')))
        AND NOT EXISTS (SELECT 1 FROM literature_index_generations g WHERE g.item_id=i.id AND g.version_id IS i.current_version_id
          AND g.profile_id=? AND g.status IN ('queued','building','ready'))`).all(saved.profile.id) as Row[];
      for (const item of waiting) {
        try { enqueueLiteratureIndex({ id: String(item.created_by), role: 'RESEARCHER' }, item); }
        catch (error) { console.warn('Existing literature indexing not queued:', item.id, (error as Error).message.slice(0, 200)); }
      }
    }
    res.json(saved);
  }));
  app.post('/api/admin/literature/embedding-config/test', requireAuth, requireAdmin, route(async (_req, res) => {
    const status = getLiteratureEmbeddingStatus();
    if (status.embedding.status !== 'configured') return res.status(409).json({ ok: false, embedding: status.embedding, missing: status.missing });
    try {
      const result = await embedOpenAiCompatible(['IVD synthetic embedding connectivity check.'], status.config);
      const vector = await literatureVectorHealth();
      res.json({ ok: result.usage.status === 'known' && vector.status === 'connected', embedding: { status: 'response_received',
        dimensions: result.vectors[0]?.length, usage: result.usage.status }, vector });
    } catch (error) { res.json({ ok: false, embedding: { status: (error as any)?.code || 'failed', message: (error as Error).message.slice(0, 300) }, vector: await literatureVectorHealth() }); }
  }));
  app.get('/api/admin/literature/vector-health', requireAuth, requireAdmin, route(async (_req, res) => res.json({
    configured: getLiteratureEmbeddingStatus().qdrant, health: await literatureVectorHealth(),
  })));
  app.get('/api/literature/stats', requireAuth, route((_req, res) => res.json(getLiteratureStats())));

  app.get('/api/literature/collections', requireAuth, route((_req, res) => res.json(listLiteratureCollections())));
  app.post('/api/literature/collections', requireAuth, route((req, res) => {
    const values = collectionNameBody(req);
    const collectionId = createCollection(actor(req), values.name, values.description);
    res.status(201).json({ id: collectionId, ...db.prepare('SELECT * FROM literature_collections WHERE id=?').get(collectionId) });
  }));
  app.patch('/api/literature/collections/:id', requireAuth, route((req, res) => {
    const collection = collectionById(param(req, 'id'));
    if (!collection) return res.status(404).json({ error: '文献集合不存在' });
    updateCollection(actor(req), collection, collectionNameBody(req));
    res.json(db.prepare('SELECT * FROM literature_collections WHERE id=?').get(collection.id));
  }));
  app.delete('/api/literature/collections/:id', requireAuth, route((req, res) => {
    const collection = collectionById(param(req, 'id'));
    if (!collection) return res.status(404).json({ error: '文献集合不存在' });
    deleteCollection(actor(req), collection);
    res.json({ ok: true });
  }));

  app.get('/api/literature', requireAuth, route(async (req, res) => {
    const query = optional(req.query.q);
    const filters = { collectionId: optional(req.query.collectionId), year: optional(req.query.year), author: optional(req.query.author),
      status: optional(req.query.status), actorId: actor(req).id, role: actor(req).role };
    if (!query) {
      const rows = listLiteratureRows({ q: query, ...filters });
      return res.json({ rows, stats: getLiteratureStats(), search: { mode: 'semantic', fallbackReason: '' } });
    }
    const result = await searchLiterature(query, { mode: 'semantic', collectionId: filters.collectionId, actor: actor(req), scope: { allowAll: true }, limit: 10 });
    const rowsByLiteratureId = new Map<string, Row>();
    for (const hit of result.results) {
      const literatureId = String(hit.literatureId || hit.itemId || hit.id);
      if (rowsByLiteratureId.has(literatureId)) continue;
      rowsByLiteratureId.set(literatureId, { ...hit, id: literatureId, literatureId,
        authors: hit.authors || JSON.parse(String(hit.authors_json || '[]')),
        keywords: hit.keywords || JSON.parse(String(hit.keywords_json || '[]')), searchRank: hit.rank,
        searchMode: hit.retrieval || result.mode, searchExcerpt: hit.excerpt, searchLocator: hit.locator, searchEvidenceRefId: hit.evidenceRefId });
    }
    const rows = [...rowsByLiteratureId.values()];
    res.json({ rows, stats: getLiteratureStats(), search: { mode: result.mode, fallbackReason: result.fallbackReason, usage: result.usage } });
  }));

  app.get('/api/literature/trash', requireAuth, route((req, res) => res.json(listDeletedLiterature(actor(req)))));

  app.get('/api/literature/search', requireAuth, route(async (req, res) => {
    const query = optional(req.query.q);
    if (!query || query.length > 1000) return res.status(400).json({ error: '请输入不超过 1,000 字的检索内容' });
    const requestedMode = ['hybrid','semantic','keyword'].includes(String(req.query.mode)) ? String(req.query.mode) as 'hybrid'|'semantic'|'keyword' : 'hybrid';
    const result = await searchLiterature(query, { mode: 'semantic', collectionId: optional(req.query.collectionId), actor: actor(req), scope: { allowAll: true }, limit: 10 });
    res.json({ mode: result.mode, fallbackReason: result.fallbackReason, usage: result.usage, results: result.results.map(row => ({
      id: row.literatureId || row.itemId || row.id, literatureId: row.literatureId || row.itemId || row.id,
      itemId: row.itemId || row.item_id || row.id, title: row.title, authors: row.authors || JSON.parse(String(row.authors_json || '[]')), publicationYear: row.publication_year,
      doi: row.doi, currentVersionId: row.current_version_id, indexStatus: row.index_status || 'not_indexed', chunkId: row.chunkId,
      evidenceRefId: row.evidenceRefId, excerpt: row.excerpt, locator: row.locator, retrieval: row.retrieval,
    })) });
  }));

  app.post('/api/literature', requireAuth, uploadParser((req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    batchUpload(req, res, next);
  }), route((req, res) => {
    const files = ((req as AuthRequest & { files?: Express.Multer.File[] }).files || []) as UploadFile[];
    const body = req.body || {};
    const records = parseRecordList(body.records);
    if (!files.length && records.length) return res.status(400).json({ error: '批量书目信息需要同时上传文献文件' });
    if (!files.length) {
      const values = normalizeLiteratureInput(body);
      const duplicates = duplicateCandidates(values);
      const itemId = createLiteratureRecord(actor(req), body);
      const details = getLiteratureDetails(itemId, actor(req));
      return res.status(201).json({ item: details, duplicates });
    }
    const results: Row[] = [];
    for (const [index, file] of files.entries()) {
      try {
        validateLiteratureFile(file);
        const input = { ...body, ...(records[index] || {}) };
        const values = normalizeLiteratureInput(input, file);
        const duplicates = duplicateCandidates(values, file);
        const itemId = createLiteratureRecord(actor(req), input, file, '首次上传');
        results.push({ ok: true, index, fileName: file.originalname, item: getLiteratureDetails(itemId, actor(req)), duplicates });
      } catch (error) {
        results.push({ ok: false, index, fileName: String(file.originalname || '').slice(0, 240), error: (error as Error).message || '文献未保存' });
      }
    }
    const successCount = results.filter(row => row.ok).length;
    const failureCount = results.length - successCount;
    res.status(failureCount ? successCount ? 207 : 422 : 201).json({ results, successCount, failureCount });
  }));

  app.get('/api/literature/:id', requireAuth, route((req, res) => {
    const details = getLiteratureDetails(param(req, 'id'), actor(req));
    if (!details) return res.status(404).json({ error: '文献不存在或已移入回收站' });
    res.json({ ...details, metadataHistory: db.prepare(`SELECT m.revision,m.snapshot_json,m.created_at,u.name AS changed_by_name FROM literature_metadata_versions m
      JOIN users u ON u.id=m.changed_by WHERE m.item_id=? ORDER BY m.revision DESC LIMIT 50`).all(details.id) });
  }));

  app.patch('/api/literature/:id', requireAuth, route((req, res) => {
    const item = literatureById(param(req, 'id'));
    if (!actorCanEdit(req, res, item)) return;
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return res.status(400).json({ error: '请提供当前文献修订号 expectedRevision' });
    if (expectedRevision !== Number(item!.revision)) return res.status(409).json({ error: '文献信息已更新，请刷新后再保存', latestRevision: item!.revision });
    try {
      updateLiteratureMetadata(actor(req), item!, req.body || {});
    } catch (error) {
      if ((error as any)?.status === 409) return res.status(409).json({ error: (error as Error).message, latestRevision: Number(literatureById(param(req, 'id'))?.revision || 0) });
      throw error;
    }
    res.json(getLiteratureDetails(param(req, 'id'), actor(req)));
  }));

  app.post('/api/literature/:id/versions', requireAuth, uploadParser(versionUpload), route((req, res) => {
    const item = literatureById(param(req, 'id'));
    if (!actorCanEdit(req, res, item)) return;
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file as UploadFile | undefined;
    if (!file) return res.status(400).json({ error: '请选择 PDF、DOCX、TXT 或 Markdown 文件' });
    const expectedRevision = Number(req.body?.expectedRevision);
    if (expectedRevision !== Number(item!.revision)) return res.status(409).json({ error: '文献信息已更新，请刷新后再替换全文', latestRevision: item!.revision });
    const duplicates = duplicateCandidates(normalizeLiteratureInput({ title: item!.title, authors: JSON.parse(item!.authors_json), year: item!.publication_year,
      journal: item!.journal, doi: item!.doi, pmid: item!.pmid, originalUrl: item!.original_url, language: item!.language,
      abstract: item!.abstract, keywords: JSON.parse(item!.keywords_json) }), file, item!.id);
    const versionId = replaceLiteratureFile(actor(req), item!, file, optional(req.body?.changeNote));
    res.status(201).json({ item: getLiteratureDetails(param(req, 'id'), actor(req)), versionId, duplicates });
  }));

  app.get('/api/literature/:id/versions/:versionId/download', requireAuth, route((req, res) => {
    const item = literatureById(param(req, 'id'));
    if (!item) return res.status(404).json({ error: '文献不存在或已移入回收站' });
    const version = readLiteratureVersion(String(item.id), param(req, 'versionId'));
    if (!version) return res.status(404).json({ error: '文献版本不存在' });
    const target = safeLiteraturePath(String(version.storage_key));
    if (!target) return res.status(404).json({ error: '文献文件缺失或存储键无效' });
    res.setHeader('Content-Type', String(version.mime_type));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(String(version.original_name))}`);
    res.sendFile(target);
  }));

  app.get('/api/literature/:id/extractions/:extractionId/chunks', requireAuth, route((req, res) => {
    const item = literatureById(param(req, 'id'));
    if (!item) return res.status(404).json({ error: '文献不存在或已移入回收站' });
    const extraction = db.prepare(`SELECT * FROM literature_extractions WHERE id=? AND item_id=? AND version_id=?`)
      .get(param(req, 'extractionId'), item.id, item.current_version_id) as Row | undefined;
    if (!extraction) return res.status(404).json({ error: '此解析结果已不属于当前全文版本' });
    const chunks = db.prepare('SELECT id,sequence_no,source_extent,locator_json,section_title,content_text,content_sha256 FROM literature_chunks WHERE extraction_id=? ORDER BY sequence_no')
      .all(extraction.id) as Row[];
    res.json({ extraction: { ...extraction, coverage: JSON.parse(extraction.coverage_json) }, chunks: chunks.map(row => ({ ...row, locator: JSON.parse(row.locator_json) })) });
  }));

  app.delete('/api/literature/:id', requireAuth, route((req, res) => {
    const item = literatureById(param(req, 'id'));
    if (!actorCanEdit(req, res, item)) return;
    const expectedRevision = req.body?.expectedRevision === undefined ? Number(item!.revision) : Number(req.body.expectedRevision);
    if (expectedRevision !== Number(item!.revision)) return res.status(409).json({ error: '文献信息已更新，请刷新后再删除', latestRevision: item!.revision });
    setLiteratureDeleted(actor(req), item!, true);
    res.json({ ok: true });
  }));

  app.post('/api/literature/:id/restore', requireAuth, route((req, res) => {
    const item = itemByIdIncludingDeleted(param(req, 'id'));
    if (!item || !item.deleted_at) return res.status(404).json({ error: '已删除文献不存在' });
    if (!mayEditLiterature(actor(req), item)) return res.status(403).json({ error: '仅文献上传者或管理员可恢复文献' });
    setLiteratureDeleted(actor(req), item, false);
    res.json(getLiteratureDetails(param(req, 'id'), actor(req)));
  }));

  app.get('/api/literature/evidence/:evidenceId', requireAuth, route((req, res) => {
    const reference = db.prepare(`SELECT r.*,i.title,i.authors_json,i.publication_year,i.journal,i.doi,i.pmid,i.deleted_at,i.revision,
        i.current_version_id,v.sha256 AS current_sha256
      FROM literature_evidence_refs r JOIN literature_items i ON i.id=r.item_id LEFT JOIN literature_file_versions v ON v.id=i.current_version_id
      WHERE r.id=?`).get(param(req, 'evidenceId')) as Row | undefined;
    if (!reference || reference.deleted_at || (reference.version_id && reference.version_id !== reference.current_version_id)
      || (reference.version_id && reference.extraction_sha256 && reference.extraction_sha256 !== reference.current_sha256)
      || (['metadata','abstract'].includes(String(reference.source_extent)) && Number(reference.metadata_revision) !== Number(reference.revision))) {
      return res.status(404).json({ error: '文献证据已删除或来自过期全文版本' });
    }
    const currentChunk = reference.chunk_id ? db.prepare('SELECT content_text,content_sha256,locator_json FROM literature_chunks WHERE id=? AND item_id=?').get(reference.chunk_id, reference.item_id) as Row | undefined : undefined;
    if (reference.chunk_id && (!currentChunk || currentChunk.content_sha256 !== reference.content_sha256)) return res.status(404).json({ error: '文献证据片段已失效' });
    res.json({ ...reference, authors: JSON.parse(reference.authors_json), chunk: currentChunk ? { ...currentChunk, locator: JSON.parse(currentChunk.locator_json) } : null });
  }));

  app.post('/api/literature/:id/index', requireAuth, route((req, res) => {
    const item = literatureById(param(req, 'id'));
    if (!actorCanEdit(req, res, item)) return;
    try { res.status(202).json(enqueueLiteratureIndex(actor(req), item!)); }
    catch (error) { if ((error as any)?.status) return res.status((error as any).status).json({ error: (error as Error).message, code: (error as any).code }); throw error; }
  }));
  app.get('/api/literature/:id/index-status', requireAuth, route((req, res) => {
    const item = literatureById(param(req, 'id'));
    if (!item) return res.status(404).json({ error: '文献不存在或已移入回收站' });
    res.json({ generations: db.prepare(`SELECT g.*,p.model,p.dimensions,p.distance,p.fingerprint FROM literature_index_generations g
      JOIN literature_embedding_profiles p ON p.id=g.profile_id WHERE g.item_id=? ORDER BY g.created_at DESC LIMIT 20`).all(item.id),
      jobs: db.prepare("SELECT id,status,progress_json,error_code,error_message,usage_tokens,usage_request_count,usage_pending_count,usage_unknown_count,usage_status,usage_stop_reason,budget_tokens,budget_requests,updated_at FROM literature_jobs WHERE item_id=? AND job_type IN ('index','rebuild') ORDER BY created_at DESC LIMIT 30")
        .all(item.id).map((job: any) => ({ ...job, progress: JSON.parse(job.progress_json || '{}') })) });
  }));

  app.post('/api/literature/jobs/:jobId/cancel', requireAuth, route((req, res) => {
    const job = db.prepare('SELECT * FROM literature_jobs WHERE id=? AND job_type IN (\'index\',\'rebuild\')').get(param(req, 'jobId')) as Row | undefined;
    if (!job) return res.status(404).json({ error: '文献索引任务不存在' });
    const item = literatureById(String(job.item_id));
    if (!item) return res.status(404).json({ error: '文献不存在或已移入回收站' });
    if (!mayEditLiterature(actor(req), item)) return res.status(403).json({ error: '仅文献上传者或管理员可取消索引任务' });
    if (!['queued','waiting_configuration','embedding','publishing'].includes(String(job.status))) return res.status(409).json({ error: '此任务状态不能取消', status: job.status });
    db.prepare(`UPDATE literature_jobs SET status='cancelled',cancel_requested=1,lease_owner=NULL,lease_until_ms=NULL,finished_at=datetime('now'),
      updated_at=datetime('now'),usage_unknown_count=usage_unknown_count+usage_pending_count,usage_status=CASE WHEN usage_pending_count>0 THEN CASE WHEN usage_tokens>0 THEN 'partial_unknown' ELSE 'unknown' END ELSE usage_status END,
      usage_stop_reason=CASE WHEN usage_pending_count>0 THEN 'cancelled_pending_request_unknown' ELSE usage_stop_reason END,usage_pending_count=0,error_message='用户取消了文献索引任务'
      WHERE id=? AND status IN ('queued','waiting_configuration','embedding','publishing')`).run(job.id);
    db.prepare("UPDATE literature_index_generations SET status='cancelled' WHERE id=? AND status IN ('queued','building')").run(job.generation_id);
    auditLiterature(actor(req).id, 'literature.index.cancel', 'literature_job', String(job.id), { itemId: item.id, generationId: job.generation_id });
    res.json({ ok: true, status: 'cancelled' });
  }));
  app.post('/api/literature/jobs/:jobId/retry', requireAuth, route((req, res) => {
    const job = db.prepare("SELECT * FROM literature_jobs WHERE id=? AND job_type IN ('index','rebuild')").get(param(req, 'jobId')) as Row | undefined;
    if (!job) return res.status(404).json({ error: '文献索引任务不存在' });
    const item = literatureById(String(job.item_id));
    if (!item) return res.status(404).json({ error: '文献不存在或已移入回收站' });
    if (!mayEditLiterature(actor(req), item)) return res.status(403).json({ error: '仅文献上传者或管理员可重试索引任务' });
    if (!['failed','partial'].includes(String(job.status)) || ['unknown','partial_unknown'].includes(String(job.usage_status))) {
      return res.status(409).json({ error: '此任务不能重试；未确认的模型用量会阻止后续请求', status: job.status, usageStatus: job.usage_status });
    }
    if (Number(job.attempt_count) >= Number(job.max_attempts)) return res.status(409).json({ error: '任务已达到最大尝试次数，请修改 Embedding profile 后显式重建。' });
    const retryable = ['http_429','worker_lease_expired','qdrant_unavailable','qdrant_timeout'].includes(String(job.error_code));
    if (!retryable) return res.status(409).json({ error: '此失败类型不适合原任务重试；请修正配置后重新建立索引。', errorCode: job.error_code });
    db.prepare(`UPDATE literature_jobs SET status='queued',lease_owner=NULL,lease_until_ms=NULL,finished_at=NULL,updated_at=datetime('now'),
      cancel_requested=0,error_message='',progress_json=? WHERE id=? AND status IN ('failed','partial')`)
      .run(JSON.stringify({ stage: 'queued', message: '管理员发起有限次数重试；已知用量与请求次数继续累计' }), job.id);
    db.prepare("UPDATE literature_index_generations SET status='queued' WHERE id=? AND status IN ('failed','partial')").run(job.generation_id);
    auditLiterature(actor(req).id, 'literature.index.retry', 'literature_job', String(job.id), { itemId: item.id, attemptCount: job.attempt_count,
      usageTokens: job.usage_tokens, usageRequestCount: job.usage_request_count });
    res.status(202).json({ ok: true, status: 'queued', jobId: job.id });
  }));
}
