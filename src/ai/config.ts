import { db, id } from '../db.ts';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

export type AiProvider = 'openai' | 'openai-compatible';
export type AiConfig = {
  provider: AiProvider;
  model: string;
  baseUrl: string;
  autoArchive: boolean;
  /** Maximum output tokens from one provider response. */
  maxTokens: number;
  /** Cumulative provider-reported input + output + cache tokens allowed for one queued task. */
  taskTokenBudget: number;
  timeoutMs: number;
  maxToolCalls: number;
};

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'openai-compatible', model: '', baseUrl: '', autoArchive: true, maxTokens: 8192, taskTokenBudget: 32_768,
  timeoutMs: 90_000, maxToolCalls: 8,
};

export function getAiConfig(): AiConfig {
  const row = db.prepare("SELECT setting_value FROM system_settings WHERE setting_key='ai_config'").get() as { setting_value?: string } | undefined;
  if (!row?.setting_value) return { ...DEFAULT_AI_CONFIG };
  try {
    const value = JSON.parse(row.setting_value) as Partial<AiConfig>;
    return {
      provider: value.provider === 'openai' ? 'openai' : 'openai-compatible',
      model: typeof value.model === 'string' ? value.model : '',
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
      autoArchive: value.autoArchive !== false,
      maxTokens: clampInt(value.maxTokens, 1024, 32_768, DEFAULT_AI_CONFIG.maxTokens),
      taskTokenBudget: clampInt(value.taskTokenBudget, 1024, 1_000_000, DEFAULT_AI_CONFIG.taskTokenBudget),
      timeoutMs: clampInt(value.timeoutMs, 5_000, 300_000, DEFAULT_AI_CONFIG.timeoutMs),
      maxToolCalls: clampInt(value.maxToolCalls, 1, 24, DEFAULT_AI_CONFIG.maxToolCalls),
    };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
}

export function saveAiConfig(config: AiConfig, actorId: string) {
  const provider = config.provider === 'openai' ? 'openai' : 'openai-compatible';
  const model = String(config.model || '').trim().slice(0, 200);
  const baseUrl = String(config.baseUrl || '').trim().slice(0, 1000);
  if (provider === 'openai-compatible' && baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('兼容接口地址不是有效的 HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('兼容接口地址需为有效的 HTTP(S) URL，且不得包含账号信息或片段');
    if (!url.pathname.endsWith('/v1')) throw new Error('兼容接口地址请填写到 /v1，例如 https://example.test/v1');
  }
  if (provider === 'openai' && baseUrl) throw new Error('官方 OpenAI provider 使用 SDK 固定接口地址；自定义服务请选择 OpenAI 兼容接口');
  const normalized: AiConfig = {
    provider, model, baseUrl, autoArchive: Boolean(config.autoArchive),
    maxTokens: clampInt(config.maxTokens, 1024, 32_768, DEFAULT_AI_CONFIG.maxTokens),
    taskTokenBudget: clampInt(config.taskTokenBudget, 1024, 1_000_000, DEFAULT_AI_CONFIG.taskTokenBudget),
    timeoutMs: clampInt(config.timeoutMs, 5_000, 300_000, DEFAULT_AI_CONFIG.timeoutMs),
    maxToolCalls: clampInt(config.maxToolCalls, 1, 24, DEFAULT_AI_CONFIG.maxToolCalls),
  };
  db.prepare(`INSERT INTO system_settings(setting_key,setting_value,updated_by,updated_at) VALUES ('ai_config',?,?,datetime('now'))
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=datetime('now')`)
    .run(JSON.stringify(normalized), actorId || null);
  db.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)`)
    .run(id('aud_'), actorId || null, 'ai.config.update', 'ai_config', '', JSON.stringify({ ...normalized, hasSecret: Boolean(process.env.IVD_AI_API_KEY) }));
  return normalized;
}

export function aiConfigStatus(config = getAiConfig()) {
  const hasApiKey = Boolean(String(process.env.IVD_AI_API_KEY || '').trim());
  const missing: string[] = [];
  if (!config.model) missing.push('model');
  if (!hasApiKey) missing.push('IVD_AI_API_KEY');
  if (config.provider === 'openai-compatible' && !config.baseUrl) missing.push('baseUrl');
  if (config.provider === 'openai' && config.model && !openaiProvider().getModels().some(model => model.id === config.model)) missing.push('official_model_id');
  return {
    provider: config.provider, model: config.model, baseUrl: config.baseUrl, autoArchive: config.autoArchive,
    maxTokens: config.maxTokens, taskTokenBudget: config.taskTokenBudget, timeoutMs: config.timeoutMs, maxToolCalls: config.maxToolCalls,
    apiKeyConfigured: hasApiKey, status: missing.length ? 'waiting_configuration' : 'configured', missing,
    keySource: '仅服务端环境变量 IVD_AI_API_KEY；不接受数据库、浏览器或个人 Pi/Codex 登录态。',
  };
}
