import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { db, id, transaction } from '../db.ts';
import { LITERATURE_CHUNKER_VERSION, LITERATURE_PARSER_VERSION } from './parser.ts';

const secretDir = path.resolve(process.env.DATA_DIR || 'data');
const secretPath = path.join(secretDir, 'embedding-api-key');
export function getEmbeddingApiKey() {
  try { const value = readFileSync(secretPath, 'utf8').trim(); if (value) return value; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return String(process.env.IVD_EMBEDDING_API_KEY || '').trim();
}
function saveEmbeddingApiKey(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096 || /[\r\n]/.test(value)) throw new Error('请输入有效的 Embedding API Key');
  mkdirSync(secretDir, { recursive: true });
  const temp = path.join(secretDir, `.embedding-key-${randomUUID()}`);
  writeFileSync(temp, value.trim(), { mode: 0o600, flag: 'wx' });
  renameSync(temp, secretPath);
}

export type LiteratureEmbeddingConfig = {
  baseUrl: string; model: string; dimensions: number; distance: 'Cosine' | 'Dot' | 'Euclid' | 'Manhattan';
  documentPrefix: string; queryPrefix: string; sendDimensions: boolean; autoIndex: boolean; batchSize: number;
  maxInputChars: number; timeoutMs: number; taskTokenBudget: number; maxRequests: number;
  queryTokenBudget: number; queryMaxRequests: number;
};
type Row = Record<string, any>;

export const DEFAULT_LITERATURE_EMBEDDING_CONFIG: LiteratureEmbeddingConfig = {
  baseUrl: '', model: '', dimensions: 0, distance: 'Cosine', documentPrefix: '', queryPrefix: '', sendDimensions: false,
  autoIndex: true, batchSize: 16, maxInputChars: 6000, timeoutMs: 45_000, taskTokenBudget: 100_000, maxRequests: 200,
  queryTokenBudget: 20_000, queryMaxRequests: 100,
};

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const safeEndpoint = (value: unknown) => {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Embedding 地址需要是有效 HTTP(S) URL，并填写到 /v1'); }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)
    || url.username || url.password || url.hash || url.search || !url.pathname.replace(/\/+$/, '').endsWith('/v1')) {
    throw new Error('Embedding 地址需为 HTTPS，或仅在回环地址使用 HTTP，并以 /v1 结尾；不能包含账号、查询参数或片段');
  }
  return url.toString().replace(/\/+$/, '');
};

export function getLiteratureEmbeddingConfig(): LiteratureEmbeddingConfig {
  const stored = db.prepare("SELECT setting_value FROM system_settings WHERE setting_key='literature_embedding_config'").get() as Row | undefined;
  if (!stored?.setting_value) return { ...DEFAULT_LITERATURE_EMBEDDING_CONFIG };
  try {
    const value = JSON.parse(String(stored.setting_value)) as Partial<LiteratureEmbeddingConfig>;
    return {
      baseUrl: safeEndpoint(value.baseUrl), model: String(value.model || '').trim().slice(0, 200),
      dimensions: Number.isSafeInteger(value.dimensions) && Number(value.dimensions) >= 1 && Number(value.dimensions) <= 65_536 ? Number(value.dimensions) : 0,
      distance: ['Cosine', 'Dot', 'Euclid', 'Manhattan'].includes(String(value.distance)) ? value.distance as LiteratureEmbeddingConfig['distance'] : 'Cosine',
      documentPrefix: String(value.documentPrefix || '').slice(0, 500), queryPrefix: String(value.queryPrefix || '').slice(0, 500),
      sendDimensions: value.sendDimensions === true, autoIndex: true,
      batchSize: clamp(value.batchSize, 1, 64, DEFAULT_LITERATURE_EMBEDDING_CONFIG.batchSize),
      maxInputChars: clamp(value.maxInputChars, 256, 20_000, DEFAULT_LITERATURE_EMBEDDING_CONFIG.maxInputChars),
      timeoutMs: clamp(value.timeoutMs, 5_000, 300_000, DEFAULT_LITERATURE_EMBEDDING_CONFIG.timeoutMs),
      taskTokenBudget: clamp(value.taskTokenBudget, 0, 2_000_000, DEFAULT_LITERATURE_EMBEDDING_CONFIG.taskTokenBudget),
      maxRequests: clamp(value.maxRequests, 0, 10_000, DEFAULT_LITERATURE_EMBEDDING_CONFIG.maxRequests),
      queryTokenBudget: clamp(value.queryTokenBudget, 0, 2_000_000, DEFAULT_LITERATURE_EMBEDDING_CONFIG.queryTokenBudget),
      queryMaxRequests: clamp(value.queryMaxRequests, 0, 10_000, DEFAULT_LITERATURE_EMBEDDING_CONFIG.queryMaxRequests),
    };
  } catch { return { ...DEFAULT_LITERATURE_EMBEDDING_CONFIG }; }
}

export function literatureProfileFingerprint(config: LiteratureEmbeddingConfig) {
  const payload = JSON.stringify({ endpoint: config.baseUrl, model: config.model, dimensions: config.dimensions, distance: config.distance,
    documentPrefix: config.documentPrefix, queryPrefix: config.queryPrefix, chunker: LITERATURE_CHUNKER_VERSION, parser: LITERATURE_PARSER_VERSION });
  return createHash('sha256').update(payload).digest('hex');
}

function activeProfile(config: LiteratureEmbeddingConfig) {
  if (!config.baseUrl || !config.model || !config.dimensions) return undefined;
  const fingerprint = literatureProfileFingerprint(config);
  return db.prepare('SELECT * FROM literature_embedding_profiles WHERE fingerprint=?').get(fingerprint) as Row | undefined;
}

export function saveLiteratureEmbeddingConfig(actorId: string, input: Partial<LiteratureEmbeddingConfig> & { apiKey?: string }) {
  if (Object.prototype.hasOwnProperty.call(input, 'secret') || Object.prototype.hasOwnProperty.call(input, 'qdrantApiKey')) throw new Error('Qdrant 密钥通过服务端环境变量配置');
  const previous = getLiteratureEmbeddingConfig();
  const config: LiteratureEmbeddingConfig = {
    baseUrl: input.baseUrl === undefined ? previous.baseUrl : safeEndpoint(input.baseUrl),
    model: input.model === undefined ? previous.model : String(input.model || '').trim().slice(0, 200),
    dimensions: input.dimensions === undefined ? previous.dimensions : Number(input.dimensions),
    distance: input.distance === undefined ? previous.distance : ['Cosine','Dot','Euclid','Manhattan'].includes(String(input.distance)) ? input.distance as LiteratureEmbeddingConfig['distance'] : 'Cosine',
    documentPrefix: input.documentPrefix === undefined ? previous.documentPrefix : String(input.documentPrefix || '').slice(0, 500),
    queryPrefix: input.queryPrefix === undefined ? previous.queryPrefix : String(input.queryPrefix || '').slice(0, 500),
    sendDimensions: input.sendDimensions === undefined ? previous.sendDimensions : input.sendDimensions === true,
    autoIndex: true,
    batchSize: input.batchSize === undefined ? previous.batchSize : clamp(input.batchSize, 1, 64, previous.batchSize),
    maxInputChars: input.maxInputChars === undefined ? previous.maxInputChars : clamp(input.maxInputChars, 256, 20_000, previous.maxInputChars),
    timeoutMs: input.timeoutMs === undefined ? previous.timeoutMs : clamp(input.timeoutMs, 5_000, 300_000, previous.timeoutMs),
    taskTokenBudget: input.taskTokenBudget === undefined ? previous.taskTokenBudget : clamp(input.taskTokenBudget, 0, 2_000_000, previous.taskTokenBudget),
    maxRequests: input.maxRequests === undefined ? previous.maxRequests : clamp(input.maxRequests, 0, 10_000, previous.maxRequests),
    queryTokenBudget: input.queryTokenBudget === undefined ? previous.queryTokenBudget : clamp(input.queryTokenBudget, 0, 2_000_000, previous.queryTokenBudget),
    queryMaxRequests: input.queryMaxRequests === undefined ? previous.queryMaxRequests : clamp(input.queryMaxRequests, 0, 10_000, previous.queryMaxRequests),
  };
  if (input.dimensions !== undefined && (!Number.isSafeInteger(Number(input.dimensions)) || Number(input.dimensions) < 1 || Number(input.dimensions) > 65_536)) throw new Error('Embedding 维度需为 1 至 65,536 之间的正整数');
  if (config.model.length > 200 || /[\r\n\u0000]/.test(config.model)) throw new Error('Embedding 模型名称格式无效');
  if ((config.baseUrl || config.model || config.dimensions) && (!config.baseUrl || !config.model || !config.dimensions)) {
    throw new Error('启用 Embedding 前请填写服务地址、模型名和期望维度；留空三项可停用在线向量化。');
  }
  if (input.apiKey !== undefined && input.apiKey.trim()) saveEmbeddingApiKey(input.apiKey);
  const fingerprint = literatureProfileFingerprint(config);
  const previousProfile = getActiveLiteratureProfile();
  const profileChanged = (previousProfile?.fingerprint || '') !== (config.baseUrl && config.model && config.dimensions ? fingerprint : '');
  transaction(() => {
    db.prepare(`INSERT INTO system_settings(setting_key,setting_value,updated_by,updated_at) VALUES ('literature_embedding_config',?,?,datetime('now'))
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(JSON.stringify(config), actorId);
    if (config.baseUrl && config.model && config.dimensions) {
      db.prepare('UPDATE literature_embedding_profiles SET active=0 WHERE active=1').run();
      db.prepare(`INSERT INTO literature_embedding_profiles(id,fingerprint,endpoint_url,model,dimensions,distance,document_prefix,query_prefix,
        send_dimensions,chunker_version,parser_version,generation,active,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
        ON CONFLICT(fingerprint) DO UPDATE SET active=1`)
        .run(id('leprof_'), fingerprint, config.baseUrl, config.model, config.dimensions, config.distance, config.documentPrefix,
          config.queryPrefix, config.sendDimensions ? 1 : 0, LITERATURE_CHUNKER_VERSION, LITERATURE_PARSER_VERSION, 1, actorId);
    } else db.prepare('UPDATE literature_embedding_profiles SET active=0 WHERE active=1').run();
    if (profileChanged && previousProfile) {
      const jobs = db.prepare(`SELECT id,generation_id,usage_tokens,usage_pending_count FROM literature_jobs
        WHERE profile_id=? AND job_type IN ('index','rebuild') AND status IN ('queued','waiting_configuration','embedding','publishing')`)
        .all(previousProfile.id) as Row[];
      for (const job of jobs) {
        const pending = Number(job.usage_pending_count || 0);
        db.prepare(`UPDATE literature_jobs SET status='superseded',cancel_requested=1,lease_owner=NULL,lease_until_ms=NULL,finished_at=datetime('now'),
          updated_at=datetime('now'),usage_pending_count=0,usage_unknown_count=usage_unknown_count+?,
          usage_status=CASE WHEN ?>0 THEN CASE WHEN usage_tokens>0 THEN 'partial_unknown' ELSE 'unknown' END ELSE usage_status END,
          usage_stop_reason=CASE WHEN ?>0 THEN 'profile_changed_pending_usage_unknown' ELSE usage_stop_reason END,
          error_code='profile_changed',error_message='Embedding profile 已变更，旧索引任务已停止'
          WHERE id=? AND status IN ('queued','waiting_configuration','embedding','publishing')`)
          .run(pending, pending, pending, job.id);
        db.prepare("UPDATE literature_index_generations SET status='stale' WHERE id=? AND status IN ('queued','building')").run(job.generation_id);
      }
    }
    db.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)`)
      .run(id('aud_'), actorId, 'literature.embedding.config', 'literature_embedding_config', '', JSON.stringify({ fingerprint, model: config.model,
        dimensions: config.dimensions, autoIndex: config.autoIndex, hasKey: Boolean(getEmbeddingApiKey()), hasQdrantKey: Boolean(process.env.QDRANT_API_KEY) }));
  });
  return getLiteratureEmbeddingStatus();
}

export function getLiteratureEmbeddingStatus() {
  const config = getLiteratureEmbeddingConfig();
  const profile = activeProfile(config);
  const keyConfigured = Boolean(getEmbeddingApiKey());
  const qdrantUrl = String(process.env.QDRANT_URL || '').trim();
  const qdrantKeyConfigured = Boolean(String(process.env.QDRANT_API_KEY || '').trim());
  const missing = [] as string[];
  if (!config.baseUrl) missing.push('Embedding 服务地址');
  if (!config.model) missing.push('Embedding 模型');
  if (!config.dimensions) missing.push('期望维度');
  if (!keyConfigured) missing.push('IVD_EMBEDDING_API_KEY');
  if (!qdrantUrl) missing.push('QDRANT_URL');
  return {
    config, profile: profile ? { id: profile.id, fingerprint: profile.fingerprint, model: profile.model, dimensions: profile.dimensions,
      distance: profile.distance, generation: profile.generation, active: Boolean(profile.active) } : null,
    embedding: { configured: Boolean(config.baseUrl && config.model && config.dimensions), keyConfigured,
      status: !config.baseUrl || !config.model || !config.dimensions || !keyConfigured ? 'waiting_configuration' : 'configured',
      keySource: '服务端本地文件优先，未设置时使用 IVD_EMBEDDING_API_KEY 环境变量。' },
    qdrant: { configured: Boolean(qdrantUrl), keyConfigured: qdrantKeyConfigured, url: qdrantUrl,
      status: qdrantUrl ? 'configured' : 'waiting_configuration', keySource: '仅服务端环境变量 QDRANT_API_KEY。' },
    autoIndex: config.autoIndex, missing,
  };
}

export function getActiveLiteratureProfile(): Row | undefined {
  const config = getLiteratureEmbeddingConfig();
  return activeProfile(config);
}
