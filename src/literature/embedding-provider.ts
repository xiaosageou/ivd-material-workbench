import { getEmbeddingApiKey, type LiteratureEmbeddingConfig } from './embedding-config.ts';

export type EmbeddingUsage = { status: 'known' | 'unknown'; promptTokens: number | null; totalTokens: number | null; responseId: string };
export type EmbeddingResult = { vectors: number[][]; usage: EmbeddingUsage; model: string };
export class EmbeddingRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly usageOutcome: 'rejected' | 'unknown';
  constructor(message: string, code: string, retryable: boolean, usageOutcome: 'rejected' | 'unknown') {
    super(message); this.code = code; this.retryable = retryable; this.usageOutcome = usageOutcome;
  }
}

function safeResponseModel(value: unknown) { return String(value || '').slice(0, 200); }
const boundedError = (status: number) => `Embedding 服务返回 HTTP ${status}；响应正文与凭据不会写入日志。`;

export async function embedOpenAiCompatible(inputs: string[], profile: Pick<LiteratureEmbeddingConfig, 'baseUrl' | 'model' | 'dimensions' | 'sendDimensions' | 'maxInputChars' | 'timeoutMs'>,
  options: { apiKey?: string; signal?: AbortSignal } = {}): Promise<EmbeddingResult> {
  if (!inputs.length || inputs.length > 64) throw new EmbeddingRequestError('Embedding 请求批次需为 1–64 条输入', 'input_batch_limit', false, 'rejected');
  if (inputs.some(text => typeof text !== 'string' || !text.trim() || text.length > profile.maxInputChars || Buffer.byteLength(text, 'utf8') > profile.maxInputChars)) {
    throw new EmbeddingRequestError('Embedding 输入为空或超过配置的字符/UTF-8 字节上限', 'input_size_limit', false, 'rejected');
  }
  const key = String(options.apiKey ?? getEmbeddingApiKey()).trim();
  if (!profile.baseUrl || !profile.model || !profile.dimensions || !key) throw new EmbeddingRequestError('Embedding 服务或服务端密钥尚未配置', 'waiting_configuration', false, 'rejected');
  const endpoint = `${profile.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const timeout = AbortSignal.timeout(profile.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    const body: Record<string, unknown> = { model: profile.model, input: inputs };
    if (profile.sendDimensions) body.dimensions = profile.dimensions;
    response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal });
  } catch (error) {
    if (options.signal?.aborted) throw new EmbeddingRequestError('Embedding 请求已取消；该请求的计费用量状态未知。', 'request_cancelled_unknown', false, 'unknown');
    const timeoutError = error instanceof Error && error.name === 'TimeoutError';
    throw new EmbeddingRequestError(timeoutError ? 'Embedding 请求超时；该请求的计费用量状态未知。' : 'Embedding 网络请求失败；该请求的计费用量状态未知。',
      timeoutError ? 'request_timeout_unknown' : 'network_unknown', false, 'unknown');
  }
  if (!response.ok) {
    const status = response.status;
    const rejected = status === 400 || status === 401 || status === 403 || status === 404 || status === 422 || status === 429;
    throw new EmbeddingRequestError(boundedError(status), `http_${status}`, status === 429, rejected ? 'rejected' : 'unknown');
  }
  let payload: any;
  try { payload = await response.json(); }
  catch { throw new EmbeddingRequestError('Embedding 响应不是有效 JSON；该请求的计费用量状态未知。', 'invalid_json_unknown', false, 'unknown'); }
  const data = payload && Array.isArray(payload.data) ? payload.data : null;
  if (!data || data.length !== inputs.length) throw new EmbeddingRequestError('Embedding 响应条数与输入不一致；计费用量状态未知。', 'response_count_unknown', false, 'unknown');
  const indexed: Array<number[] | undefined> = Array(inputs.length);
  for (const item of data) {
    if (!item || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= inputs.length || indexed[item.index]) {
      throw new EmbeddingRequestError('Embedding 响应包含缺失、重复或越界的 index。', 'response_index_invalid', false, 'unknown');
    }
    if (!Array.isArray(item.embedding) || item.embedding.length !== profile.dimensions || item.embedding.length === 0
      || item.embedding.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new EmbeddingRequestError('Embedding 向量维度或数值格式与配置不匹配。', 'vector_shape_invalid', false, 'unknown');
    }
    const vector = item.embedding as number[];
    if (!vector.some(value => value !== 0)) throw new EmbeddingRequestError('Embedding 响应包含零向量。', 'zero_vector_invalid', false, 'unknown');
    indexed[item.index] = vector;
  }
  if (indexed.some(vector => !vector)) throw new EmbeddingRequestError('Embedding 响应缺少输入索引。', 'response_index_missing', false, 'unknown');
  const usage = payload.usage || {};
  const promptTokens = Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? Number(usage.prompt_tokens) : null;
  const totalTokens = Number.isSafeInteger(usage.total_tokens) && usage.total_tokens >= 0 ? Number(usage.total_tokens) : null;
  const usageKnown = promptTokens !== null && totalTokens !== null && totalTokens >= promptTokens
    && !(inputs.some(text => text.trim().length > 0) && totalTokens === 0);
  return { vectors: indexed as number[][], model: safeResponseModel(payload.model), usage: {
    status: usageKnown ? 'known' : 'unknown', promptTokens: usageKnown ? promptTokens : null, totalTokens: usageKnown ? totalTokens : null,
    responseId: String(payload.id || '').slice(0, 200),
  } };
}
