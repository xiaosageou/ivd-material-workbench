import { createHash, randomUUID } from 'node:crypto';
import { db, id, transaction } from '../db.ts';
import { getAiConfig } from './config.ts';
import { currentReportManifest, appendJobEvent, type Row } from './jobs.ts';
import { readCurrentEvidence } from './knowledge.ts';
import { isLiteratureInScope, readCurrentLiteratureEvidence, type LiteratureScope } from '../literature/search.ts';

const parseJson = (value: unknown, fallback: any = {}) => { try { return JSON.parse(String(value ?? '')); } catch { return fallback; } };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function getOwnedSession(sessionId: string, ownerId: string) {
  return db.prepare('SELECT * FROM assistant_sessions WHERE id=? AND owner_id=? AND deleted_at IS NULL').get(sessionId, ownerId) as Row | undefined;
}

function readLiteratureScope(sessionId: string, ownerId: string): { scope?: LiteratureScope; scopeType?: string; reportScope?: string[] } {
  const row = db.prepare('SELECT * FROM literature_session_scopes WHERE session_id=? AND owner_id=?').get(sessionId, ownerId) as Row | undefined;
  if (!row) return {};
  const literatureIds = parseJson(row.literature_ids_json, []) as string[];
  const reportIds = parseJson(row.report_ids_json, []) as string[];
  if (row.scope_type === 'items') return { scope: { itemIds: literatureIds }, scopeType: 'items', reportScope: [] };
  if (row.scope_type === 'collections') return { scope: { collectionIds: literatureIds }, scopeType: 'collections', reportScope: [] };
  const allowAll = literatureIds.length === 0 && reportIds.length === 0;
  return { scope: { itemIds: literatureIds, reportIds, allowAll }, scopeType: 'reports_literature', reportScope: reportIds.length ? reportIds : allowAll ? undefined : [] };
}

function normalizeLiteratureScope(ownerId: string, raw: unknown) {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('文献会话范围格式无效');
  const value = raw as Row;
  const type = String(value.type || 'items');
  if (!['items','collections','reports_literature'].includes(type)) throw new Error('文献会话范围类型无效');
  const literatureIds = [...new Set((Array.isArray(value.literatureIds) ? value.literatureIds : []).map(String).map(item => item.trim()).filter(Boolean))].slice(0, 100);
  const reportIds = [...new Set((Array.isArray(value.reportIds) ? value.reportIds : []).map(String).map(item => item.trim()).filter(Boolean))].slice(0, 50);
  if (type === 'items' && literatureIds.length) {
    const count = Number((db.prepare(`SELECT COUNT(*) AS n FROM literature_items WHERE deleted_at IS NULL AND id IN (${literatureIds.map(() => '?').join(',')})`).get(...literatureIds) as Row).n);
    if (count !== literatureIds.length) throw new Error('所选文献不存在或已删除');
  }
  if (type === 'collections' && literatureIds.length) {
    const count = Number((db.prepare(`SELECT COUNT(*) AS n FROM literature_collections WHERE deleted_at IS NULL AND id IN (${literatureIds.map(() => '?').join(',')})`).get(...literatureIds) as Row).n);
    if (count !== literatureIds.length) throw new Error('所选文献集合不存在或已归档');
  }
  if (type === 'reports_literature') {
    if (literatureIds.length) {
      const count = Number((db.prepare(`SELECT COUNT(*) AS n FROM literature_items WHERE deleted_at IS NULL AND id IN (${literatureIds.map(() => '?').join(',')})`).get(...literatureIds) as Row).n);
      if (count !== literatureIds.length) throw new Error('所选文献不存在或已删除');
    }
    if (reportIds.length) {
      const count = Number((db.prepare(`SELECT COUNT(*) AS n FROM research_reports WHERE deleted_at IS NULL AND id IN (${reportIds.map(() => '?').join(',')})`).get(...reportIds) as Row).n);
      if (count !== reportIds.length) throw new Error('所选报告不存在或已删除');
    }
    if (!literatureIds.length && !reportIds.length && value.allowAll !== true) throw new Error('选择知识库全部资料时需显式确认');
  }
  return { type, literatureIds, reportIds, ownerId };
}

export function createAssistantSession(ownerId: string, contextType: unknown, rawIds: unknown, title?: unknown, rawLiteratureScope?: unknown) {
  const allowed = ['knowledge_base', 'report', 'reports', 'recipe'];
  const type = allowed.includes(String(contextType)) ? String(contextType) : 'knowledge_base';
  const contextIds = Array.isArray(rawIds) ? [...new Set(rawIds.map(value => String(value).trim()).filter(Boolean))].slice(0, 50) : [];
  if (type === 'report' && contextIds.length !== 1) throw new Error('单报告会话必须指定一份报告');
  if (type === 'reports' && contextIds.length < 1) throw new Error('跨报告会话至少选择一份报告');
  if (type === 'report' || type === 'reports') {
    const count = Number((db.prepare(`SELECT COUNT(*) AS n FROM research_reports WHERE deleted_at IS NULL AND id IN (${contextIds.map(() => '?').join(',')})`)
      .get(...contextIds) as Row).n);
    if (count !== contextIds.length) throw new Error('所选报告不存在或已删除');
  }
  if (type === 'recipe') {
    if (contextIds.length !== 1 || !db.prepare(`SELECT 1 FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id WHERE v.id=? AND r.active=1 AND r.scope='team'`).get(contextIds[0])) {
      throw new Error('指定的组织共享配方版本不存在');
    }
  }
  const literatureScope = normalizeLiteratureScope(ownerId, rawLiteratureScope);
  const sessionId = id('sess_');
  transaction(() => {
    db.prepare(`INSERT INTO assistant_sessions(id,owner_id,context_type,context_ids_json,title) VALUES (?,?,?,?,?)`)
      .run(sessionId, ownerId, type, JSON.stringify(contextIds), String(title || '新会话').trim().slice(0, 120) || '新会话');
    if (literatureScope) db.prepare(`INSERT INTO literature_session_scopes(session_id,owner_id,scope_type,literature_ids_json,report_ids_json)
      VALUES (?,?,?,?,?)`).run(sessionId, ownerId, literatureScope.type, JSON.stringify(literatureScope.literatureIds), JSON.stringify(literatureScope.reportIds));
  });
  return sessionId;
}

export function listAssistantSessions(ownerId: string) {
  const sessions = db.prepare(`SELECT s.id,s.context_type,s.context_ids_json,s.title,s.created_at,s.updated_at,
      (SELECT content_text FROM assistant_messages m WHERE m.session_id=s.id AND m.role='user' ORDER BY sequence_no LIMIT 1) AS first_prompt,
      (SELECT COALESCE(j.status,m.status) FROM assistant_messages m LEFT JOIN ai_jobs j ON j.id=m.job_id
        WHERE m.session_id=s.id ORDER BY m.sequence_no DESC LIMIT 1) AS last_status
    FROM assistant_sessions s WHERE s.owner_id=? AND s.deleted_at IS NULL ORDER BY s.updated_at DESC LIMIT 100`).all(ownerId) as Row[];
  return sessions.map(session => ({ ...session, literatureScope: readLiteratureScope(String(session.id), ownerId).scope,
    literatureScopeType: readLiteratureScope(String(session.id), ownerId).scopeType }));
}

export function getAssistantSession(sessionId: string, ownerId: string) {
  const session = getOwnedSession(sessionId, ownerId);
  if (!session) return undefined;
  const scopeInfo = readLiteratureScope(sessionId, ownerId);
  const messages = db.prepare(`SELECT m.id,m.sequence_no,m.role,m.content_text,m.status,m.job_id,j.status AS job_status,j.error_message,
      j.budget_tokens,j.usage_input_tokens,j.usage_output_tokens,j.usage_cache_read_tokens,j.usage_cache_write_tokens,j.usage_total_tokens,
      j.usage_request_count,j.usage_pending_count,j.usage_unknown_count,j.usage_status,j.usage_stop_reason,
      j.usage_last_response_id,j.usage_last_provider_stop_reason,
      m.citations_json,m.tool_trace_json,m.created_at FROM assistant_messages m LEFT JOIN ai_jobs j ON j.id=m.job_id
    WHERE m.session_id=? ORDER BY m.sequence_no`).all(sessionId) as Row[];
  return { id: session.id, ownerId: session.owner_id, contextType: session.context_type, contextIds: parseJson(session.context_ids_json, []),
    literatureScope: scopeInfo.scope, literatureScopeType: scopeInfo.scopeType,
    title: session.title, createdAt: session.created_at, updatedAt: session.updated_at,
    messages: messages.map(message => ({ id: message.id, sequence: message.sequence_no, role: message.role, content: message.content_text,
      status: message.status, jobId: message.job_id, jobStatus: message.job_status, errorMessage: message.error_message,
      usage: message.job_id ? { budgetTokens: Number(message.budget_tokens || 0), inputTokens: Number(message.usage_input_tokens || 0),
        outputTokens: Number(message.usage_output_tokens || 0), cacheReadTokens: Number(message.usage_cache_read_tokens || 0),
        cacheWriteTokens: Number(message.usage_cache_write_tokens || 0), usedTokens: Number(message.usage_total_tokens || 0),
        requestCount: Number(message.usage_request_count || 0), pendingRequestCount: Number(message.usage_pending_count || 0),
        unknownRequestCount: Number(message.usage_unknown_count || 0), status: String(message.usage_status || 'none'),
        stopReason: String(message.usage_stop_reason || ''), lastResponseId: String(message.usage_last_response_id || ''),
        providerStopReason: String(message.usage_last_provider_stop_reason || '') } : undefined,
      citations: parseJson(message.citations_json, []).map((citation: Row) => {
        const current = citation.sourceType === 'literature' ? readCurrentLiteratureEvidence(String(citation.evidenceRefId))
          : citation.evidenceRefId ? readCurrentEvidence(String(citation.evidenceRefId)) : undefined;
        const scopeAllowed = citation.sourceType !== 'literature' || (scopeInfo.scope && isLiteratureInScope(scopeInfo.scope, String((current as any)?.itemId || '')));
        return current && scopeAllowed ? { ...citation, source: current, valid: true } : { ...citation, valid: false, source: undefined };
      }), toolTrace: parseJson(message.tool_trace_json, []), createdAt: message.created_at })) };
}

export function enqueueChatMessage(sessionId: string, ownerId: string, rawMessage: unknown) {
  const session = getOwnedSession(sessionId, ownerId);
  if (!session) throw new Error('会话不存在');
  const content = String(rawMessage || '').trim();
  if (!content || content.length > 6000) throw new Error('消息为必填项且不超过 6,000 字');
  const pending = db.prepare(`SELECT m.id FROM assistant_messages m WHERE m.session_id=? AND m.role='assistant' AND m.status IN ('queued','running') LIMIT 1`)
    .get(sessionId) as Row | undefined;
  if (pending) throw new Error('上一条回答仍在处理中，请等待完成或先取消');
  const contextIds = parseJson(session.context_ids_json, []) as string[];
  const scopeInfo = readLiteratureScope(sessionId, ownerId);
  const manifests = contextIds.map(reportId => currentReportManifest(reportId)?.fingerprint || null);
  const requestId = randomUUID();
  const jobId = id('aij_');
  const userMessageId = id('msg_');
  const assistantMessageId = id('msg_');
  const manifest = { sessionId, ownerId, contextType: session.context_type, contextIds, literatureScope: scopeInfo.scope,
    literatureScopeType: scopeInfo.scopeType, reportScope: scopeInfo.reportScope, manifests, userMessageId, assistantMessageId, requestId };
  const fingerprint = hash({ sessionId, content, manifest });
  transaction(() => {
    const sequence = Number((db.prepare('SELECT COALESCE(MAX(sequence_no),0) AS n FROM assistant_messages WHERE session_id=?').get(sessionId) as Row).n) + 1;
    db.prepare(`INSERT INTO ai_jobs(id,job_type,requested_by,input_fingerprint,input_manifest_json,run_key,status,budget_tokens,timeout_ms)
      VALUES (?,'assistant_chat',?,?,?,?,'queued',?,?)`).run(jobId, ownerId, fingerprint, JSON.stringify({ ...manifest, content }), `chat:${requestId}`,
        getAiConfig().taskTokenBudget, getAiConfig().timeoutMs);
    db.prepare(`INSERT INTO assistant_messages(id,session_id,sequence_no,role,content_text,status) VALUES (?,?,?,'user',?,'completed')`)
      .run(userMessageId, sessionId, sequence, content);
    db.prepare(`INSERT INTO assistant_messages(id,session_id,sequence_no,role,content_text,status,job_id) VALUES (?,?,?,'assistant','','queued',?)`)
      .run(assistantMessageId, sessionId, sequence + 1, jobId);
    db.prepare("UPDATE assistant_sessions SET title=CASE WHEN title='新会话' THEN ? ELSE title END,updated_at=datetime('now') WHERE id=?")
      .run(content.slice(0, 60), sessionId);
    appendJobEvent(jobId, 'queued', '助手问题已进入持久队列', { sessionId, assistantMessageId });
  });
  return { jobId, userMessageId, assistantMessageId };
}

export function getChatJob(jobId: string) {
  const job = db.prepare(`SELECT j.*,m.session_id,m.id AS assistant_message_id FROM ai_jobs j JOIN assistant_messages m ON m.job_id=j.id
    WHERE j.id=? AND j.job_type='assistant_chat' AND m.role='assistant'`).get(jobId) as Row | undefined;
  if (!job) return undefined;
  return { job, manifest: { ...parseJson(job.input_manifest_json), content: String(parseJson(job.input_manifest_json).content || '') } };
}

export function buildCurrentPiHistory(rows: Row[], contextType: string, contextIds: string[], literatureScope?: LiteratureScope, reportScope?: string[]) {
  const restricted = contextType === 'report' || contextType === 'reports' || contextType === 'recipe';
  const allowedReports = new Set(contextIds);
  return rows.slice().reverse().map(row => {
    const role = String(row.role) as 'user' | 'assistant';
    if (role === 'user') return { role, content: String(row.content_text) };
    const citations = parseJson(row.citations_json, []) as Row[];
    const validCitations = citations.filter(citation => {
      if (!citation?.evidenceRefId) return false;
      if (citation.sourceType === 'literature') {
        const current = readCurrentLiteratureEvidence(String(citation.evidenceRefId));
        return Boolean(current && literatureScope && isLiteratureInScope(literatureScope, String(current.itemId)));
      }
      const current = readCurrentEvidence(String(citation.evidenceRefId));
      const reports = reportScope !== undefined ? new Set(reportScope) : allowedReports;
      const isRestricted = reportScope !== undefined || restricted;
      return Boolean(current && (!isRestricted || reports.has(String(current.reportId))));
    });
    if (!citations.length) return { role, content: '[此前助手答复没有可验证的来源引用，本轮不将其作为事实依据。]' };
    if (validCitations.length !== citations.length) {
      return { role, content: '[此前助手答复引用的部分资料已删除、替换或不在本会话范围内；失效事实已从本轮上下文排除，请依据当前可用来源重新回答。]' };
    }
    return { role, content: String(row.content_text) };
  });
}

export function updateAssistantMessage(jobId: string, status: string, content?: string, citations?: unknown[], trace?: unknown[], lease?: Row) {
  const parameters: Array<string | number | null> = [status, content === undefined ? null : content, citations === undefined ? null : JSON.stringify(citations),
    trace === undefined ? null : JSON.stringify(trace), jobId];
  const sql = lease
    ? `UPDATE assistant_messages SET status=?,content_text=COALESCE(?,content_text),citations_json=COALESCE(?,citations_json),
        tool_trace_json=COALESCE(?,tool_trace_json) WHERE job_id=? AND role='assistant' AND EXISTS (
          SELECT 1 FROM ai_jobs j WHERE j.id=? AND j.lease_owner=? AND j.attempt_count=? AND j.lease_until_ms>? AND j.cancel_requested=0 AND j.status!='cancelled')`
    : `UPDATE assistant_messages SET status=?,content_text=COALESCE(?,content_text),citations_json=COALESCE(?,citations_json),
        tool_trace_json=COALESCE(?,tool_trace_json) WHERE job_id=? AND role='assistant'`;
  if (lease) parameters.push(jobId, lease.lease_owner, lease.attempt_count, Date.now());
  const result = db.prepare(sql).run(...parameters);
  return result.changes > 0;
}

export function cancelAssistantSession(sessionId: string, ownerId: string) {
  const session = getOwnedSession(sessionId, ownerId);
  if (!session) return false;
  const active = db.prepare(`SELECT j.id FROM ai_jobs j JOIN assistant_messages m ON m.job_id=j.id WHERE m.session_id=? AND m.role='assistant'
    AND j.status IN ('queued','waiting_configuration','parsing','analyzing','validating')`).all(sessionId) as Row[];
  transaction(() => {
    for (const job of active) {
      db.prepare(`UPDATE ai_jobs SET cancel_requested=1,status=CASE WHEN status IN ('queued','waiting_configuration') THEN 'cancelled' ELSE status END,
        finished_at=CASE WHEN status IN ('queued','waiting_configuration') THEN datetime('now') ELSE finished_at END,updated_at=datetime('now') WHERE id=?`).run(job.id);
      appendJobEvent(String(job.id), 'cancel_requested', '用户取消助手会话任务', { sessionId });
      updateAssistantMessage(String(job.id), 'cancelled', '本次回答已取消。');
    }
  });
  return true;
}

export function deleteAssistantSession(sessionId: string, ownerId: string) {
  if (!getOwnedSession(sessionId, ownerId)) return false;
  cancelAssistantSession(sessionId, ownerId);
  db.prepare("UPDATE assistant_sessions SET deleted_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND owner_id=?").run(sessionId, ownerId);
  return true;
}
