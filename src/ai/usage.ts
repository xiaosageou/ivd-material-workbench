import { db, id, transaction } from '../db.ts';
import { appendLeasedJobEvent, hasCurrentJobLease, type Row } from './jobs.ts';

export type AiTokenUsage = {
  budgetTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usedTokens: number;
  requestCount: number;
  pendingRequestCount: number;
  unknownRequestCount: number;
  status: 'none' | 'pending' | 'known' | 'unknown' | 'partial_unknown';
  stopReason: string;
  lastResponseId: string;
  providerStopReason: string;
};

export class AiTokenBudgetError extends Error {
  readonly code = 'token_budget_exhausted';
  constructor() { super('AI 任务累计 token 预算已用尽，已停止后续模型请求'); this.name = 'AiTokenBudgetError'; }
}

export class AiTokenUsageUnknownError extends Error {
  readonly code = 'token_usage_unknown';
  constructor() { super('模型请求未提供可核验用量或请求中断，用量未知；为避免突破任务预算，已停止后续模型请求'); this.name = 'AiTokenUsageUnknownError'; }
}

export class AiRequestCancelledError extends Error {
  readonly code = 'cancelled';
  constructor() { super('AI 任务已取消'); this.name = 'AiRequestCancelledError'; }
}

function usageRow(jobId: string): Row | undefined {
  return db.prepare(`SELECT id,budget_tokens,usage_input_tokens,usage_output_tokens,usage_cache_read_tokens,usage_cache_write_tokens,usage_total_tokens,usage_request_count,usage_pending_count,
      usage_unknown_count,usage_status,usage_stop_reason,usage_last_response_id,usage_last_provider_stop_reason FROM ai_jobs WHERE id=?`).get(jobId) as Row | undefined;
}

function toSnapshot(row: Row): AiTokenUsage {
  const inputTokens = Number(row.usage_input_tokens || 0);
  const outputTokens = Number(row.usage_output_tokens || 0);
  const cacheReadTokens = Number(row.usage_cache_read_tokens || 0);
  const cacheWriteTokens = Number(row.usage_cache_write_tokens || 0);
  return {
    budgetTokens: Number(row.budget_tokens || 0), inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    usedTokens: Number(row.usage_total_tokens || 0),
    requestCount: Number(row.usage_request_count || 0), pendingRequestCount: Number(row.usage_pending_count || 0),
    unknownRequestCount: Number(row.usage_unknown_count || 0),
    status: String(row.usage_status || 'none') as AiTokenUsage['status'], stopReason: String(row.usage_stop_reason || ''),
    lastResponseId: String(row.usage_last_response_id || ''), providerStopReason: String(row.usage_last_provider_stop_reason || ''),
  };
}

/** Pi totalTokens includes input + output + cacheRead + cacheWrite; reasoning is already a subset of output. */
export function normalizeProviderUsage(raw: unknown): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const usage = raw as Record<string, unknown>;
  const inputTokens = usage.input;
  const outputTokens = usage.output;
  const cacheReadTokens = usage.cacheRead;
  const cacheWriteTokens = usage.cacheWrite;
  const totalTokens = usage.totalTokens;
  if (!Number.isSafeInteger(inputTokens) || Number(inputTokens) < 0
    || !Number.isSafeInteger(outputTokens) || Number(outputTokens) < 0
    || !Number.isSafeInteger(cacheReadTokens) || Number(cacheReadTokens) < 0
    || !Number.isSafeInteger(cacheWriteTokens) || Number(cacheWriteTokens) < 0
    || !Number.isSafeInteger(totalTokens) || Number(totalTokens) < 0) return undefined;
  const expectedTotal = Number(inputTokens) + Number(outputTokens) + Number(cacheReadTokens) + Number(cacheWriteTokens);
  if (!Number.isSafeInteger(expectedTotal) || Number(totalTokens) !== expectedTotal) return undefined;
  // Pi initializes every assistant message with an all-zero Usage object. A model request always
  // contains a prompt, so zeros alone cannot prove that the provider reported an unbilled request.
  if (Number(totalTokens) === 0) return undefined;
  return { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens), cacheReadTokens: Number(cacheReadTokens),
    cacheWriteTokens: Number(cacheWriteTokens), totalTokens: Number(totalTokens) };
}

function appendUsageEvent(job: Row, type: string, message: string, metadata: Row, allowCancellation = false) {
  if (!allowCancellation) {
    if (!appendLeasedJobEvent(job, type, message, metadata)) throw new Error('AI 任务租约失效，拒绝用量写回');
    return;
  }
  const inserted = db.prepare(`INSERT INTO ai_job_events(id,job_id,sequence_no,event_type,message,metadata_json)
    SELECT ?,?,(SELECT COALESCE(MAX(sequence_no),0)+1 FROM ai_job_events WHERE job_id=?),?,?,?
    WHERE EXISTS(SELECT 1 FROM ai_jobs WHERE id=? AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND status!='cancelled')`)
    .run(id('aije_'), job.id, job.id, type, message.slice(0, 1000), JSON.stringify(metadata), job.id, job.lease_owner, job.attempt_count, Date.now());
  if (!inserted.changes) throw new Error('AI 任务租约失效，拒绝用量写回');
}

export function createJobTokenUsageController(job: Row) {
  const jobId = String(job.id);

  const snapshot = (): AiTokenUsage => {
    const row = usageRow(jobId);
    if (!row) throw new Error('AI 任务不存在，无法读取累计用量');
    return toSnapshot(row);
  };

  const beforeRequest = (signal?: AbortSignal): number => {
    if (signal?.aborted) throw new AiRequestCancelledError();
    if (!hasCurrentJobLease(job)) throw new Error('AI 任务租约已失效，拒绝发起模型请求');
    const result = transaction(() => {
      const row = usageRow(jobId);
      if (!row) throw new Error('AI 任务不存在，拒绝发起模型请求');
      const current = toSnapshot(row);
      if (current.pendingRequestCount > 0) {
        const unresolved = current.pendingRequestCount;
        db.prepare(`UPDATE ai_jobs SET usage_unknown_count=usage_unknown_count+?,usage_pending_count=0,
          usage_status=CASE WHEN usage_total_tokens>0 THEN 'partial_unknown' ELSE 'unknown' END,
          usage_stop_reason='request_interrupted_usage_unknown',updated_at=datetime('now') WHERE id=?`)
          .run(unresolved, jobId);
        appendUsageEvent(job, 'token_usage_unknown', '上次模型请求在用量写回前中断；累计用量未知，停止后续模型请求',
          { unknownRequestsAdded: unresolved, knownTotalTokens: current.usedTokens });
        return { error: 'usage_unknown' as const };
      }
      if (current.unknownRequestCount > 0 || current.status === 'unknown' || current.status === 'partial_unknown') {
        return { error: 'usage_unknown' as const };
      }
      if (current.usedTokens >= current.budgetTokens) {
        if (!current.stopReason) {
          db.prepare(`UPDATE ai_jobs SET usage_stop_reason='budget_exhausted',updated_at=datetime('now') WHERE id=? AND usage_stop_reason=''`).run(jobId);
          appendUsageEvent(job, 'token_budget_stop', '任务累计 token 预算已耗尽，已阻止后续模型请求',
            { budgetTokens: current.budgetTokens, usedTokens: current.usedTokens });
        }
        return { error: 'budget_exhausted' as const };
      }
      const updated = db.prepare(`UPDATE ai_jobs SET usage_request_count=usage_request_count+1,usage_pending_count=usage_pending_count+1,
        usage_status='pending',updated_at=datetime('now') WHERE id=? AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
        .run(jobId, job.lease_owner, job.attempt_count, Date.now());
      if (!updated.changes) throw new Error('AI 任务租约失效，拒绝登记模型请求');
      const ordinal = current.requestCount + 1;
      appendUsageEvent(job, 'model_request_started', '已登记本次模型请求；等待 provider 返回用量',
        { requestOrdinal: ordinal, budgetTokens: current.budgetTokens, knownUsedTokens: current.usedTokens,
          remainingTokensBeforeRequest: current.budgetTokens - current.usedTokens });
      return { remainingTokens: current.budgetTokens - current.usedTokens };
    });
    if ('error' in result) {
      if (result.error === 'usage_unknown') throw new AiTokenUsageUnknownError();
      throw new AiTokenBudgetError();
    }
    return result.remainingTokens;
  };

  const recordProviderMessage = (rawUsage: unknown, stopReason: unknown, responseId?: unknown) => transaction(() => {
    if (!hasCurrentJobLease(job, true)) throw new Error('AI 任务租约失效，拒绝用量写回');
    const row = usageRow(jobId);
    if (!row) throw new Error('AI 任务不存在，拒绝用量写回');
    const current = toSnapshot(row);
    if (current.pendingRequestCount < 1) return current;
    const reported = stopReason === 'aborted' ? undefined : normalizeProviderUsage(rawUsage);
    if (!reported) {
      const nextUnknown = current.unknownRequestCount + 1;
      const status = current.usedTokens > 0 ? 'partial_unknown' : 'unknown';
      const reason = stopReason === 'error' || stopReason === 'aborted' ? 'request_failed_usage_unknown' : 'provider_usage_missing';
      db.prepare(`UPDATE ai_jobs SET usage_pending_count=usage_pending_count-1,usage_unknown_count=usage_unknown_count+1,
        usage_status=?,usage_stop_reason=?,usage_last_response_id=?,usage_last_provider_stop_reason=?,updated_at=datetime('now')
        WHERE id=? AND usage_pending_count>0`)
        .run(status, reason, String(responseId || '').slice(0, 300), String(stopReason || 'unknown').slice(0, 80), jobId);
      appendUsageEvent(job, 'token_usage_unknown', 'provider 未返回可核验的本次 token 用量；已知累计数保留，后续模型请求停止',
        { requestOrdinal: current.requestCount, unknownRequestCount: nextUnknown, knownTotalTokens: current.usedTokens,
          providerStopReason: String(stopReason || 'unknown') }, true);
      return snapshot();
    }
    const inputTokens = current.inputTokens + reported.inputTokens;
    const outputTokens = current.outputTokens + reported.outputTokens;
    const cacheReadTokens = current.cacheReadTokens + reported.cacheReadTokens;
    const cacheWriteTokens = current.cacheWriteTokens + reported.cacheWriteTokens;
    const usedTokens = current.usedTokens + reported.totalTokens;
    const stop = usedTokens > current.budgetTokens ? 'budget_exceeded_by_inflight_request'
      : usedTokens === current.budgetTokens ? 'budget_exhausted' : current.stopReason;
    db.prepare(`UPDATE ai_jobs SET usage_input_tokens=?,usage_output_tokens=?,usage_cache_read_tokens=?,usage_cache_write_tokens=?,usage_total_tokens=?,usage_pending_count=usage_pending_count-1,
      usage_status=CASE WHEN usage_unknown_count>0 THEN 'partial_unknown' ELSE 'known' END,
      usage_stop_reason=?,usage_last_response_id=?,usage_last_provider_stop_reason=?,updated_at=datetime('now') WHERE id=? AND usage_pending_count>0`)
      .run(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, usedTokens, stop, String(responseId || '').slice(0, 300), String(stopReason || 'unknown').slice(0, 80), jobId);
    appendUsageEvent(job, 'token_usage_recorded', '已保存 provider 报告的 input/output/cache/total token 用量',
      { requestOrdinal: current.requestCount, requestInputTokens: reported.inputTokens, requestOutputTokens: reported.outputTokens,
        requestCacheReadTokens: reported.cacheReadTokens, requestCacheWriteTokens: reported.cacheWriteTokens, requestTotalTokens: reported.totalTokens,
        cumulativeInputTokens: inputTokens, cumulativeOutputTokens: outputTokens, cumulativeCacheReadTokens: cacheReadTokens,
        cumulativeCacheWriteTokens: cacheWriteTokens, cumulativeTotalTokens: usedTokens, budgetTokens: current.budgetTokens,
        overBudget: usedTokens > current.budgetTokens, responseId: String(responseId || '').slice(0, 300), providerStopReason: String(stopReason || 'unknown') }, true);
    return snapshot();
  });

  return { beforeRequest, recordProviderMessage, snapshot };
}

/** Close a request whose worker/provider stream ended without a final usage message. */
export function markPendingUsageUnknown(job: Row) {
  return transaction(() => {
    if (!hasCurrentJobLease(job, true)) return false;
    const row = usageRow(String(job.id));
    if (!row) return false;
    const current = toSnapshot(row);
    if (current.pendingRequestCount < 1) return false;
    const unresolved = current.pendingRequestCount;
    const status = current.usedTokens > 0 ? 'partial_unknown' : 'unknown';
    const changed = db.prepare(`UPDATE ai_jobs SET usage_unknown_count=usage_unknown_count+usage_pending_count,usage_pending_count=0,
      usage_status=?,usage_stop_reason='request_interrupted_usage_unknown',updated_at=datetime('now')
      WHERE id=? AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND usage_pending_count>0`)
      .run(status, job.id, job.lease_owner, job.attempt_count, Date.now());
    if (!changed.changes) return false;
    appendUsageEvent(job, 'token_usage_unknown', '模型请求结束时没有可核验用量；保留已知用量并停止后续请求',
      { unknownRequestsAdded: unresolved, knownTotalTokens: current.usedTokens }, true);
    return true;
  });
}

