import { AiTokenBudgetError, AiTokenUsageUnknownError } from './usage.ts';

export type AiErrorClassification = {
  code: string;
  message: string;
  retryable: boolean;
};

export function classifyAiTaskError(error: unknown, usageUnknown = false): AiErrorClassification {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = `${(error as any)?.code || ''} ${(error as any)?.name || ''} ${raw}`.toLocaleLowerCase();
  if (error instanceof AiTokenBudgetError || /token_budget_exhausted|budget_exhausted_by_inflight_request|累计 token 预算/.test(text)) {
    return { code: 'token_budget_exhausted', message: '任务累计 token 预算已耗尽，后续模型请求已停止。', retryable: false };
  }
  if (/cancelled|canceled|aborted|任务已取消/.test(text)) {
    return { code: 'cancelled', message: '任务已取消。', retryable: false };
  }
  if (/\bquota_exhausted\b|insufficient[_ ]quota|quota[_ ]exceeded|billing|credit balance|payment required|\b402\b/.test(text)) {
    return { code: 'quota_exhausted', message: '模型服务额度或配额不足，任务已停止。', retryable: false };
  }
  if (/\bcredential_error\b|invalid[_ ]api[_ ]key|incorrect api key|unauthorized|authentication|credential|\b401\b|\b403\b|api key/.test(text)) {
    return { code: 'credential_error', message: '模型凭据无效或未配置，请管理员检查服务端凭据。', retryable: false };
  }
  if (/\binput_error\b|invalid[_ -]?request|context[_ -]?length|unsupported parameter|unsupported file|\b400\b/.test(text)) {
    return { code: 'input_error', message: '模型服务判定本次输入或请求参数无效，任务未自动重试。', retryable: false };
  }
  if (/rate[_ -]?limit|too many requests|\b429\b|retry-after/.test(text)) {
    return { code: 'rate_limited', message: usageUnknown
      ? '模型服务触发限流；请求用量未返回，为避免超出任务预算已停止自动重试。'
      : '模型服务触发限流；将按有限退避策略重试。', retryable: true };
  }
  if (/timeout|timed out|etimedout|deadline exceeded|超过配置的运行时限/.test(text)) {
    return { code: 'network_timeout', message: usageUnknown
      ? '模型请求超时；服务端可能已接收请求，但用量未知，因此任务已停止自动重试。'
      : '模型请求超时；请求可能已被服务端接收，任务用量状态已保留。', retryable: true };
  }
  if (/econnreset|econnrefused|enotfound|eai_again|fetch failed|socket|network|connection reset/.test(text)) {
    return { code: 'network_error', message: usageUnknown
      ? '模型服务网络连接失败且本次用量未知；为控制累计预算已停止自动重试。'
      : '模型服务网络连接失败；任务用量状态已保留。', retryable: true };
  }
  if (error instanceof AiTokenUsageUnknownError || usageUnknown || /token_usage_unknown|usage_unavailable|usage_unknown/.test(text)) {
    return { code: 'usage_unknown', message: '模型请求用量未知；为避免超出任务预算，任务已停止且不会自动重试。', retryable: false };
  }
  return { code: 'processing_error', message: '任务处理失败；已按剩余尝试次数和用量状态决定是否退避重试。', retryable: true };
}

export function retryDelayMs(attempt: number) {
  return Math.min(30_000, 1000 * 2 ** Math.max(1, Math.min(10, Math.floor(attempt))));
}

export function planAiTaskRetry(error: unknown, attempt: number, maxAttempts: number, usageUnknown: boolean) {
  const classification = classifyAiTaskError(error, usageUnknown);
  const retryable = classification.retryable && !usageUnknown && attempt < maxAttempts;
  return { classification, retryable, delayMs: retryable ? retryDelayMs(attempt) : 0 };
}
