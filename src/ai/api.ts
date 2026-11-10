import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { db, id, transaction } from '../db.ts';
import { getAiConfig, aiConfigStatus, saveAiConfig } from './config.ts';
import { appendJobEvent, enqueueManualReportJob, currentReportManifest, type Row } from './jobs.ts';
import { runPiAgent, piRuntimeConfigured } from './provider.ts';
import { searchKnowledge, resolveObservationValue } from './knowledge.ts';
import { createAssistantSession, deleteAssistantSession, enqueueChatMessage, getAssistantSession, getOwnedSession, listAssistantSessions, cancelAssistantSession } from './chat.ts';
import { confirmSuggestion, editSuggestion, enqueueSuggestionJob, getSuggestionForUser } from './suggestions.ts';
import { reportKnowledgeIndexStatus, enqueueReportKnowledgeIndex, retryReportKnowledgeIndex, semanticSearchReportKnowledge,
  setReportKnowledgeExternalizationEnabled } from '../report-knowledge.ts';

type AuthRequest = Request & { user?: Row };
const param = (req: Request, key: string) => String(req.params[key] ?? '');
const wrapped = (handler: (req: AuthRequest, res: Response) => unknown | Promise<unknown>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => { try { Promise.resolve(handler(req, res)).catch(next); } catch (error) { next(error); } };
const row = (table: string, idValue: string) => db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(idValue) as Row | undefined;

function activeReport(reportId: string) {
  return db.prepare('SELECT * FROM research_reports WHERE id=? AND deleted_at IS NULL').get(reportId) as Row | undefined;
}

function workerStatus() {
  const rows = db.prepare('SELECT worker_id,process_id,started_at,last_seen_ms,status FROM ai_worker_heartbeats ORDER BY last_seen_ms DESC').all() as Row[];
  const now = Date.now();
  const live = rows.filter(item => Number(item.last_seen_ms) > now - 20_000 && item.status === 'online');
  return { online: live.length > 0, workers: live.map(item => ({ processId: item.process_id, startedAt: item.started_at, lastSeenMs: item.last_seen_ms })) };
}

function reportJobs(reportId: string) {
  return db.prepare(`SELECT id,job_type,status,progress_json,error_code,error_message,provider,model,attempt_count,max_attempts,budget_tokens,
      usage_input_tokens,usage_output_tokens,usage_cache_read_tokens,usage_cache_write_tokens,usage_total_tokens,usage_request_count,usage_pending_count,usage_unknown_count,usage_status,usage_stop_reason,
      usage_last_response_id,usage_last_provider_stop_reason,
      created_at,started_at,finished_at,updated_at
    FROM ai_jobs WHERE report_id=? ORDER BY created_at DESC LIMIT 30`).all(reportId) as Row[];
}

function taskUsage(job: Row) {
  const inputTokens = Number(job.usage_input_tokens || 0);
  const outputTokens = Number(job.usage_output_tokens || 0);
  const cacheReadTokens = Number(job.usage_cache_read_tokens || 0);
  const cacheWriteTokens = Number(job.usage_cache_write_tokens || 0);
  return { budgetTokens: Number(job.budget_tokens || 0), inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    usedTokens: Number(job.usage_total_tokens || 0),
    requestCount: Number(job.usage_request_count || 0), pendingRequestCount: Number(job.usage_pending_count || 0),
    unknownRequestCount: Number(job.usage_unknown_count || 0), status: String(job.usage_status || 'none'),
    stopReason: String(job.usage_stop_reason || ''), lastResponseId: String(job.usage_last_response_id || ''),
    providerStopReason: String(job.usage_last_provider_stop_reason || '') };
}

function latestReview(observationId: string) {
  return db.prepare(`SELECT * FROM observation_reviews WHERE observation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(observationId) as Row | undefined;
}

export function installAiRoutes(app: Express, requireAuth: RequestHandler, requireAdmin: RequestHandler) {
  app.get('/api/ai/status', requireAuth, wrapped((_req, res) => {
    const config = getAiConfig();
    const queue = db.prepare(`SELECT status,COUNT(*) AS count FROM ai_jobs GROUP BY status`).all() as Row[];
    res.json({ ...aiConfigStatus(config), runtimeReady: piRuntimeConfigured(config), worker: workerStatus(), queue });
  }));

  app.get('/api/ai/admin/config', requireAuth, requireAdmin, wrapped((_req, res) => res.json(aiConfigStatus(getAiConfig()))));
  app.patch('/api/ai/admin/config', requireAuth, requireAdmin, wrapped((req, res) => {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'apiKey') || Object.prototype.hasOwnProperty.call(req.body || {}, 'secret')) {
      return res.status(400).json({ error: '密钥只通过服务端 IVD_AI_API_KEY 环境变量配置' });
    }
    const previous = getAiConfig();
    const input = req.body || {};
    const saved = saveAiConfig({
      provider: input.provider === 'openai' ? 'openai' : input.provider === 'openai-compatible' ? 'openai-compatible' : previous.provider,
      model: input.model === undefined ? previous.model : String(input.model),
      baseUrl: input.baseUrl === undefined ? previous.baseUrl : String(input.baseUrl),
      autoArchive: input.autoArchive === undefined ? previous.autoArchive : input.autoArchive === true,
      maxTokens: input.maxTokens === undefined ? previous.maxTokens : Number(input.maxTokens),
      taskTokenBudget: input.taskTokenBudget === undefined ? previous.taskTokenBudget : Number(input.taskTokenBudget),
      timeoutMs: input.timeoutMs === undefined ? previous.timeoutMs : Number(input.timeoutMs),
      maxToolCalls: input.maxToolCalls === undefined ? previous.maxToolCalls : Number(input.maxToolCalls),
    }, req.user!.id);
    res.json(aiConfigStatus(saved));
  }));

  app.post('/api/ai/admin/test-connection', requireAuth, requireAdmin, wrapped(async (_req, res) => {
    const config = getAiConfig();
    if (!piRuntimeConfigured(config)) return res.status(409).json({ ok: false, status: 'waiting_configuration', missing: aiConfigStatus(config).missing });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 30_000));
    try {
      const result = await runPiAgent({ config, systemPrompt: '只进行模型连接检测。', prompt: '请只输出 IVD_AI_CONNECTION_OK，不需要读取任何研发资料。', signal: controller.signal });
      const ok = result.text.trim().includes('IVD_AI_CONNECTION_OK');
      res.json({ ok, status: ok ? 'connected' : 'response_received', message: ok ? 'Pi provider 已返回连接检测标记。' : '收到模型响应，但未返回精确连接标记。' });
    } catch (error) {
      res.json({ ok: false, status: 'connection_failed', message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    } finally { clearTimeout(timeout); }
  }));

  app.get('/api/ai/reports/:id/analysis', requireAuth, wrapped((req, res) => {
    const reportId = param(req, 'id');
    if (!activeReport(reportId)) return res.status(404).json({ error: '研发报告不存在' });
    const manifest = currentReportManifest(reportId);
    const analyses = db.prepare(`SELECT a.*,j.created_at AS job_created_at FROM research_analyses a JOIN ai_jobs j ON j.id=a.job_id
      WHERE a.report_id=? ORDER BY a.created_at DESC LIMIT 30`).all(reportId) as Row[];
    const currentRow = analyses.find(item => {
      try { return JSON.parse(String(item.input_manifest_json)).fingerprint === manifest?.fingerprint && item.status !== 'invalidated'; }
      catch { return false; }
    });
    const shapeAnalysis = (item: Row) => {
      let inputFingerprint = '';
      try { inputFingerprint = String(JSON.parse(String(item.input_manifest_json)).fingerprint || ''); } catch { /* Invalid legacy manifest stays visibly historical. */ }
      const structured = (() => { try { return JSON.parse(String(item.structured_json || '{}')); } catch { return {}; } })();
      return { id: item.id, jobId: item.job_id, status: item.status, summary: item.summary, evidenceGaps: (() => { try { return JSON.parse(String(item.evidence_gaps_json || '[]')); } catch { return []; } })(),
        coverage: (() => { try { return JSON.parse(String(item.coverage_json || '{}')); } catch { return {}; } })(),
        structured, inputFingerprint, current: item.id === currentRow?.id, createdAt: item.created_at, provider: item.provider, model: item.model };
    };
    const sources = (manifest?.sources || []).map(source => {
      const extraction = db.prepare(`SELECT id,parser_version,status,coverage_json,text_length,created_at FROM document_extractions
        WHERE report_id=? AND source_version_id=? AND input_sha256=? ORDER BY created_at DESC,rowid DESC LIMIT 1`)
        .get(reportId, source.id, source.content_sha256) as Row | undefined;
      let coverage: Row = {};
      try { coverage = extraction ? JSON.parse(String(extraction.coverage_json || '{}')) : {}; } catch { coverage = {}; }
      return { sourceVersionId: source.id, kind: source.kind, name: source.original_name, extension: source.extension, sizeBytes: source.size_bytes,
        contentSha256: source.content_sha256, extraction: extraction ? { id: extraction.id, parserVersion: extraction.parser_version, status: extraction.status,
          coverage, textLength: Number(extraction.text_length), createdAt: extraction.created_at } : null };
    });
    res.json({ current: currentRow ? shapeAnalysis(currentRow) : undefined, analyses: analyses.map(shapeAnalysis), sources,
      jobs: reportJobs(reportId).map(item => ({ ...item, progress: (() => { try { return JSON.parse(String(item.progress_json || '{}')); } catch { return {}; } })(), usage: taskUsage(item) })),
      config: aiConfigStatus(getAiConfig()), worker: workerStatus() });
  }));

  app.post('/api/ai/reports/:id/analyze', requireAuth, wrapped((req, res) => {
    const reportId = param(req, 'id');
    const report = activeReport(reportId);
    if (!report) return res.status(404).json({ error: '研发报告不存在' });
    if (req.user!.role !== 'ADMIN' && req.user!.id !== report.created_by) return res.status(403).json({ error: '仅报告上传者或管理员可发起重分析' });
    const active = db.prepare(`SELECT id,status FROM ai_jobs WHERE report_id=? AND job_type='report_analysis'
      AND status IN ('queued','waiting_configuration','parsing','analyzing','validating') ORDER BY created_at DESC LIMIT 1`).get(reportId) as Row | undefined;
    if (active) return res.status(409).json({ error: '已有报告分析任务正在排队或处理中', jobId: active.id, status: active.status });
    const job = enqueueManualReportJob(reportId, req.user!.id);
    if (!job) return res.status(400).json({ error: '报告缺少可读取的正文版本' });
    res.status(202).json({ jobId: job.id, status: 'queued' });
  }));

  app.get('/api/ai/reports/:id/evidence', requireAuth, wrapped((req, res) => {
    const reportId = param(req, 'id');
    if (!activeReport(reportId)) return res.status(404).json({ error: '研发报告不存在' });
    const manifest = currentReportManifest(reportId);
    const currentSources = new Set(manifest?.sources.map(source => source.id) || []);
    const query = String(req.query.q || '').trim().slice(0, 200);
    const chunks = db.prepare(`SELECT c.id,c.locator_json,c.content_text,c.content_sha256,e.source_version_id,e.source_kind,e.input_sha256,
        e.status AS extraction_status
      FROM document_chunks c JOIN document_extractions e ON e.id=c.extraction_id
      WHERE e.report_id=? ORDER BY e.created_at DESC,c.sequence_no LIMIT 500`).all(reportId) as Row[];
    const currentChunks = chunks.filter(chunk => currentSources.has(String(chunk.source_version_id))
      && manifest?.sources.some(source => source.id === chunk.source_version_id && source.content_sha256 === chunk.input_sha256));
    const matching = query ? currentChunks.filter(chunk => String(chunk.content_text).toLocaleLowerCase().includes(query.toLocaleLowerCase())) : currentChunks;
    res.json(matching.slice(0, 200).map(chunk => ({ id: chunk.id, sourceVersionId: chunk.source_version_id, sourceKind: chunk.source_kind,
      contentSha256: chunk.input_sha256, locator: JSON.parse(String(chunk.locator_json)), text: chunk.content_text,
      extractionStatus: chunk.extraction_status })));
  }));

  app.get('/api/ai/reports/:id/observations', requireAuth, wrapped((req, res) => {
    const reportId = param(req, 'id');
    if (!activeReport(reportId)) return res.status(404).json({ error: '研发报告不存在' });
    const current = currentReportManifest(reportId);
    const analysis = db.prepare(`SELECT * FROM research_analyses WHERE report_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30`).all(reportId) as Row[];
    const currentAnalysis = analysis.find(item => {
      try { return JSON.parse(String(item.input_manifest_json)).fingerprint === current?.fingerprint && item.status !== 'invalidated'; } catch { return false; }
    });
    const requestedAnalysisId = String(req.query.analysisId || '');
    const selectedAnalysis = requestedAnalysisId ? analysis.find(item => String(item.id) === requestedAnalysisId) : currentAnalysis;
    if (!selectedAnalysis) return res.json({ analysis: undefined, observations: [] });
    const isCurrent = selectedAnalysis.id === currentAnalysis?.id;
    const rows = db.prepare('SELECT * FROM research_observations WHERE analysis_id=? ORDER BY created_at,id').all(selectedAnalysis.id) as Row[];
    const analysisSummary = { id: selectedAnalysis.id, status: selectedAnalysis.status, summary: selectedAnalysis.summary,
      evidenceGaps: JSON.parse(String(selectedAnalysis.evidence_gaps_json || '[]')), coverage: JSON.parse(String(selectedAnalysis.coverage_json || '{}')),
      createdAt: selectedAnalysis.created_at, current: isCurrent };
    res.json({ analysis: analysisSummary,
      observations: rows.map(item => {
        const review = latestReview(String(item.id));
        const evidence = db.prepare('SELECT * FROM evidence_refs WHERE observation_id=? ORDER BY id').all(item.id) as Row[];
        const resolved = resolveObservationValue(item.value_json, review);
        return { id: item.id, fieldKey: item.field_key, observationType: item.observation_type, reviewState: item.review_state,
          reviewVersion: Number(item.review_version || 1), updatedAt: item.updated_at,
          value: resolved.value, originalValue: resolved.originalValue, review: review ? { state: review.review_state, reviewerId: review.reviewer_id,
          createdAt: review.created_at, comment: review.comment,
          correctedValue: review.corrected_value_json ? JSON.parse(String(review.corrected_value_json)) : undefined } : undefined,
          historical: !isCurrent,
          evidence: evidence.filter(ref => current?.sources.some(source => source.id === ref.source_version_id && source.content_sha256 === ref.content_sha256))
            .map(ref => ({ id: ref.id, sourceVersionId: ref.source_version_id, sourceKind: ref.source_kind, locator: JSON.parse(String(ref.locator_json)), excerpt: ref.source_excerpt })) };
      }) });
  }));

  app.post('/api/ai/observations/:id/review', requireAuth, wrapped((req, res) => {
    const observation = db.prepare(`SELECT o.*,r.created_by,r.deleted_at,a.input_manifest_json,a.status AS analysis_status FROM research_observations o
      JOIN research_reports r ON r.id=o.report_id JOIN research_analyses a ON a.id=o.analysis_id WHERE o.id=?`)
      .get(param(req, 'id')) as Row | undefined;
    if (!observation || observation.deleted_at) return res.status(404).json({ error: '结构化信息不存在或来源已删除' });
    if (req.user!.role !== 'ADMIN' && req.user!.id !== observation.created_by) return res.status(403).json({ error: '仅报告上传者或管理员可复核结构化信息' });
    let inputFingerprint = '';
    try { inputFingerprint = String(JSON.parse(String(observation.input_manifest_json)).fingerprint || ''); } catch { /* stale data is rejected below */ }
    const manifest = currentReportManifest(String(observation.report_id));
    if (!manifest || inputFingerprint !== manifest.fingerprint || observation.analysis_status === 'invalidated')
      return res.status(409).json({ error: '这条观察来自旧报告版本，请打开当前分析结果后再复核' });
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return res.status(400).json({ error: '请刷新后再提交复核版本' });
    if (expectedVersion !== Number(observation.review_version)) return res.status(409).json({ error: '这条记录已被其他人复核更新，请刷新后确认最新值', currentVersion: Number(observation.review_version) });
    const state = String(req.body?.reviewState || '');
    if (!['human_confirmed','corrected','conflict','stale'].includes(state)) return res.status(400).json({ error: '复核状态无效' });
    const priorReview = latestReview(String(observation.id));
    const priorCorrectedValue = priorReview?.corrected_value_json ? JSON.parse(String(priorReview.corrected_value_json)) : null;
    const correctedValue = state === 'corrected' ? req.body?.correctedValue : ['conflict','stale'].includes(state) ? priorCorrectedValue : null;
    if (state === 'corrected' && correctedValue === undefined) return res.status(400).json({ error: '纠正状态必须填写修正值' });
    const comment = String(req.body?.comment || '').trim().slice(0, 2000);
    if (['conflict','stale'].includes(state) && !comment) return res.status(400).json({ error: '标记冲突或来源过时时，请填写原因' });
    if (state === 'corrected') {
      let serialized = '';
      try { serialized = JSON.stringify(correctedValue); } catch { return res.status(400).json({ error: '修正值格式无效' }); }
      if (!serialized || serialized.length > 8000) return res.status(400).json({ error: '修正值不能为空且最多 8000 个字符' });
    }
    const reviewId = id('rev_');
    const committed = transaction(() => {
      const latest = db.prepare('SELECT review_version FROM research_observations WHERE id=?').get(observation.id) as Row | undefined;
      if (!latest || Number(latest.review_version) !== expectedVersion) return false;
      db.prepare(`INSERT INTO observation_reviews(id,observation_id,reviewer_id,review_state,corrected_value_json,comment) VALUES (?,?,?,?,?,?)`)
        .run(reviewId, observation.id, req.user!.id, state, correctedValue === null ? null : JSON.stringify(correctedValue), comment);
      const observationState = state === 'corrected' ? 'human_confirmed' : state;
      const updated = db.prepare(`UPDATE research_observations SET review_state=?,updated_at=datetime('now'),review_version=review_version+1 WHERE id=? AND review_version=?`)
        .run(observationState, observation.id, expectedVersion);
      if (!updated.changes) return false;
      db.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)`)
        .run(id('aud_'), req.user!.id, 'ai.observation.review', 'research_observation', observation.id, JSON.stringify({ state, comment, expectedVersion }));
      return true;
    });
    if (!committed) return res.status(409).json({ error: '这条记录已被其他人复核更新，请刷新后确认最新值' });
    enqueueReportKnowledgeIndex(String(observation.report_id));
    res.status(201).json({ id: reviewId, observationId: observation.id, reviewState: state, correctedValue, comment, reviewVersion: expectedVersion + 1 });
  }));

  app.get('/api/ai/jobs/:id', requireAuth, wrapped((req, res) => {
    const job = row('ai_jobs', param(req, 'id'));
    if (!job) return res.status(404).json({ error: '任务不存在' });
    if (job.job_type !== 'report_analysis' && job.requested_by !== req.user!.id && req.user!.role !== 'ADMIN') return res.status(404).json({ error: '任务不存在' });
    res.json({ id: job.id, type: job.job_type, reportId: job.report_id, status: job.status, progress: JSON.parse(String(job.progress_json)),
      errorCode: job.error_code, errorMessage: job.error_message, provider: job.provider, model: job.model, attemptCount: job.attempt_count,
      usage: taskUsage(job),
      createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at, updatedAt: job.updated_at });
  }));

  app.get('/api/ai/jobs/:id/events', requireAuth, wrapped((req, res) => {
    const job = row('ai_jobs', param(req, 'id'));
    if (!job || (job.job_type !== 'report_analysis' && job.requested_by !== req.user!.id && req.user!.role !== 'ADMIN')) return res.status(404).json({ error: '任务不存在' });
    const after = Math.max(0, Number(req.query.after || 0));
    const events = db.prepare('SELECT sequence_no,event_type,message,metadata_json,created_at FROM ai_job_events WHERE job_id=? AND sequence_no>? ORDER BY sequence_no LIMIT 200')
      .all(job.id, after) as Row[];
    res.json(events.map(item => ({ sequence: item.sequence_no, type: item.event_type, message: item.message, metadata: JSON.parse(String(item.metadata_json)), createdAt: item.created_at })));
  }));

  app.post('/api/ai/jobs/:id/cancel', requireAuth, wrapped((req, res) => {
    const job = row('ai_jobs', param(req, 'id'));
    if (!job) return res.status(404).json({ error: '任务不存在' });
    if (job.job_type === 'report_analysis') {
      const report = activeReport(String(job.report_id));
      if (!report || (req.user!.role !== 'ADMIN' && report.created_by !== req.user!.id)) return res.status(404).json({ error: '任务不存在' });
    } else if (job.requested_by !== req.user!.id && req.user!.role !== 'ADMIN') return res.status(404).json({ error: '任务不存在' });
    if (['completed','partial','failed','cancelled','superseded'].includes(String(job.status))) return res.status(409).json({ error: '任务已经结束' });
    db.prepare(`UPDATE ai_jobs SET cancel_requested=1,status=CASE WHEN status IN ('queued','waiting_configuration') THEN 'cancelled' ELSE status END,
      updated_at=datetime('now'),finished_at=CASE WHEN status IN ('queued','waiting_configuration') THEN datetime('now') ELSE finished_at END WHERE id=?`).run(job.id);
    db.prepare(`INSERT INTO ai_job_events(id,job_id,sequence_no,event_type,message,metadata_json) VALUES (?,?,?,?,?,?)`)
      .run(id('aije_'), job.id, Number((db.prepare('SELECT COALESCE(MAX(sequence_no),0)+1 AS n FROM ai_job_events WHERE job_id=?').get(job.id) as Row).n),
        'cancel_requested', '用户请求取消任务', JSON.stringify({ actorId: req.user!.id }));
    res.json({ ok: true });
  }));

  app.post('/api/ai/jobs/:id/retry', requireAuth, wrapped((req, res) => {
    const job = row('ai_jobs', param(req, 'id'));
    if (!job || job.job_type !== 'report_analysis') return res.status(404).json({ error: '报告分析任务不存在' });
    const report = activeReport(String(job.report_id));
    if (!report || (req.user!.role !== 'ADMIN' && report.created_by !== req.user!.id)) return res.status(404).json({ error: '任务不存在' });
    if (job.status !== 'failed') return res.status(409).json({ error: '只有已失败的任务可以手动重试' });
    const current = currentReportManifest(String(job.report_id));
    if (!current || current.fingerprint !== job.input_fingerprint) return res.status(409).json({ error: '报告内容已经更新，请对当前版本发起新的分析' });
    if (!['processing_error','network_error','network_timeout','rate_limited'].includes(String(job.error_code || '')))
      return res.status(409).json({ error: '此类失败不适用手动重试，请先处理任务错误后重新分析' });
    if (['pending','unknown','partial_unknown'].includes(String(job.usage_status || '')) || Number(job.usage_unknown_count || 0) > 0)
      return res.status(409).json({ error: '本任务有请求用量未知，预算保护已关闭重试' });
    if (Number(job.usage_total_tokens || 0) >= Number(job.budget_tokens || 0)) return res.status(409).json({ error: '本任务累计 token 预算已用尽，请先调整配置后重新分析' });
    const result = transaction(() => {
      const updated = db.prepare(`UPDATE ai_jobs SET status='queued',max_attempts=max_attempts+1,cancel_requested=0,lease_owner=NULL,lease_until_ms=NULL,
        finished_at=NULL,updated_at=datetime('now'),error_code=NULL,error_message=NULL,progress_json=? WHERE id=? AND status='failed' AND usage_status NOT IN ('pending','unknown','partial_unknown')`)
        .run(JSON.stringify({ stage: 'queued', message: '报告作者请求重试；沿用原任务累计预算与用量。' }), job.id);
      if (!updated.changes) return false;
      appendJobEvent(String(job.id), 'manual_retry', '报告作者请求重试；保留原任务预算和已知用量', { actorId: req.user!.id,
        attemptCount: Number(job.attempt_count || 0), maxAttempts: Number(job.max_attempts || 0) + 1 });
      return true;
    });
    if (!result) return res.status(409).json({ error: '任务状态已变化，请刷新后重试' });
    res.json({ ok: true, status: 'queued', id: job.id });
  }));

  app.get('/api/ai/jobs', requireAuth, wrapped((req, res) => {
    const reportId = String(req.query.reportId || '');
    if (reportId && !activeReport(reportId)) return res.status(404).json({ error: '研发报告不存在' });
    const rows = reportId ? reportJobs(reportId) : db.prepare(`SELECT id,job_type,report_id,status,progress_json,error_code,error_message,provider,model,attempt_count,budget_tokens,
        usage_input_tokens,usage_output_tokens,usage_cache_read_tokens,usage_cache_write_tokens,usage_total_tokens,usage_request_count,usage_pending_count,usage_unknown_count,usage_status,usage_stop_reason,
        usage_last_response_id,usage_last_provider_stop_reason,
        created_at,started_at,finished_at,updated_at
      FROM ai_jobs WHERE requested_by=? AND job_type!='report_analysis' ORDER BY created_at DESC LIMIT 100`).all(req.user!.id) as Row[];
    res.json(rows.map(item => ({ ...item, progress: item.progress_json ? JSON.parse(String(item.progress_json)) : {}, usage: taskUsage(item) })));
  }));

  app.get('/api/ai/knowledge', requireAuth, wrapped(async (req, res) => {
    const reportIds = String(req.query.reportIds || '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 50);
    const reportId = String(req.query.reportId || '').trim();
    const query = String(req.query.q || '').trim().slice(0, 200);
    const scope = reportIds.length ? reportIds : reportId ? [reportId] : undefined;
    const wantsSemantic = req.query.semantic === 'true' && req.query.includeHistory !== 'true'
      && !req.query.project && !req.query.experimentType && !req.query.materialLot && !req.query.recipeVersion && !req.query.dateFrom && !req.query.dateTo;
    const result: any = wantsSemantic
      ? await semanticSearchReportKnowledge(query, scope, Number(req.query.limit || 50), req.user!.id)
      : searchKnowledge({ q: query, reportId: reportId || undefined,
      reportIds: reportIds.length ? reportIds : undefined, fieldKey: String(req.query.fieldKey || '') || undefined,
      reviewState: String(req.query.reviewState || '') || undefined, project: String(req.query.project || '') || undefined,
      experimentType: String(req.query.experimentType || '') || undefined, materialLot: String(req.query.materialLot || '') || undefined,
      recipeVersion: String(req.query.recipeVersion || '') || undefined, dateFrom: String(req.query.dateFrom || '') || undefined,
      dateTo: String(req.query.dateTo || '') || undefined, includeHistory: req.query.includeHistory === 'true', limit: Number(req.query.limit || 50) });
    const filteredObservations = wantsSemantic ? result.observations.filter((item: Row) =>
      (!req.query.fieldKey || String(item.fieldKey).toLocaleLowerCase().includes(String(req.query.fieldKey).toLocaleLowerCase()))
      && (!req.query.reviewState || String(item.reviewState) === String(req.query.reviewState))) : result.observations;
    const reportCanReview = new Map<string, boolean>();
    for (const item of filteredObservations) {
      if (!reportCanReview.has(item.reportId)) {
        const report = db.prepare('SELECT created_by FROM research_reports WHERE id=? AND deleted_at IS NULL').get(item.reportId) as Row | undefined;
        reportCanReview.set(item.reportId, Boolean(report && (req.user!.role === 'ADMIN' || report.created_by === req.user!.id)));
      }
    }
    res.json({ ...result, mode: wantsSemantic ? result.mode : 'keyword', fallbackReason: wantsSemantic ? result.fallbackReason : '',
      observations: filteredObservations.map((item: Row) => ({ ...item, canReview: !item.historical && (reportCanReview.get(item.reportId) || false) })) });
  }));

  app.get('/api/ai/knowledge/index-status', requireAuth, wrapped((req, res) => {
    res.json({ ...reportKnowledgeIndexStatus(), canManageExternalization: req.user!.role === 'ADMIN' });
  }));

  app.patch('/api/ai/knowledge/externalization', requireAuth, requireAdmin, wrapped((req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔值' });
    res.json(setReportKnowledgeExternalizationEnabled(req.body.enabled, req.user!.id));
  }));

  app.post('/api/ai/knowledge/reports/:id/retry', requireAuth, requireAdmin, wrapped((req, res) => {
    const result = retryReportKnowledgeIndex(param(req, 'id'));
    if (!result.ok) return res.status(result.reason === 'disabled' ? 409 : 404).json({ error: result.reason === 'disabled'
      ? '请先由管理员启用报告知识语义外发' : '当前报告没有可重试的知识索引任务' });
    res.status(202).json({ id: result.id, status: 'queued' });
  }));

  app.get('/api/ai/sessions', requireAuth, wrapped((req, res) => res.json(listAssistantSessions(req.user!.id))));
  app.post('/api/ai/sessions', requireAuth, wrapped((req, res) => {
    const idValue = createAssistantSession(req.user!.id, req.body?.contextType, req.body?.contextIds, req.body?.title, req.body?.literatureScope);
    res.status(201).json(getAssistantSession(idValue, req.user!.id));
  }));
  app.get('/api/ai/sessions/:id', requireAuth, wrapped((req, res) => {
    const result = getAssistantSession(param(req, 'id'), req.user!.id);
    if (!result) return res.status(404).json({ error: '会话不存在' });
    res.json(result);
  }));
  app.post('/api/ai/sessions/:id/messages', requireAuth, wrapped((req, res) => {
    if (!getOwnedSession(param(req, 'id'), req.user!.id)) return res.status(404).json({ error: '会话不存在' });
    const result = enqueueChatMessage(param(req, 'id'), req.user!.id, req.body?.message);
    res.status(202).json({ ...result, status: 'queued' });
  }));
  app.post('/api/ai/sessions/:id/cancel', requireAuth, wrapped((req, res) => {
    if (!cancelAssistantSession(param(req, 'id'), req.user!.id)) return res.status(404).json({ error: '会话不存在' });
    res.json({ ok: true });
  }));
  app.delete('/api/ai/sessions/:id', requireAuth, wrapped((req, res) => {
    if (!deleteAssistantSession(param(req, 'id'), req.user!.id)) return res.status(404).json({ error: '会话不存在' });
    res.json({ ok: true });
  }));

  app.post('/api/ai/suggestions/recipe', requireAuth, wrapped((req, res) => {
    const jobId = enqueueSuggestionJob(req.user!.id, 'recipe', req.body || {});
    res.status(202).json({ jobId, status: 'queued' });
  }));
  app.post('/api/ai/suggestions/preparation', requireAuth, wrapped((req, res) => {
    const jobId = enqueueSuggestionJob(req.user!.id, 'preparation', req.body || {});
    res.status(202).json({ jobId, status: 'queued' });
  }));
  app.get('/api/ai/suggestions/by-job/:jobId', requireAuth, wrapped((req, res) => {
    const job = row('ai_jobs', param(req, 'jobId'));
    if (!job || (job.requested_by !== req.user!.id && req.user!.role !== 'ADMIN')) return res.status(404).json({ error: '任务不存在' });
    const suggestionRow = db.prepare('SELECT id FROM ai_suggestions WHERE job_id=?').get(job.id) as Row | undefined;
    res.json({ job: { id: job.id, status: job.status, progress: JSON.parse(String(job.progress_json || '{}')), errorMessage: job.error_message,
      usage: taskUsage(job) },
      suggestion: suggestionRow ? getSuggestionForUser(String(suggestionRow.id), req.user!.id, req.user!.role) : null });
  }));
  app.get('/api/ai/suggestions/:id', requireAuth, wrapped((req, res) => {
    const suggestion = getSuggestionForUser(param(req, 'id'), req.user!.id, req.user!.role);
    if (!suggestion) return res.status(404).json({ error: '建议不存在' });
    res.json(suggestion);
  }));
  app.patch('/api/ai/suggestions/:id', requireAuth, wrapped((req, res) => {
    const suggestion = editSuggestion(param(req, 'id'), req.user!.id, req.user!.role, req.body || {});
    if (!suggestion) return res.status(404).json({ error: '建议不存在' });
    res.json(suggestion);
  }));
  app.post('/api/ai/suggestions/:id/confirm', requireAuth, wrapped((req, res) => {
    const result = confirmSuggestion(param(req, 'id'), req.user!.id, req.user!.role, req.body?.idempotencyKey, req.body?.expectedVersion);
    res.json(result);
  }));
}
