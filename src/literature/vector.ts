import { createHash } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';

type PointInput = { id: string; vector: number[]; payload: Record<string, unknown> };
const COLLECTION = /^ivd_lit_[a-f0-9]{12}_g[1-9][0-9]*$/;
const REPORT_COLLECTION = /^ivd_rpt_[a-f0-9]{12}_g[1-9][0-9]*$/;
const clientCache = new Map<string, QdrantClient>();

export function qdrantClient() {
  const url = String(process.env.QDRANT_URL || '').trim();
  if (!url) throw Object.assign(new Error('QDRANT_URL 未配置'), { code: 'qdrant_not_configured' });
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw Object.assign(new Error('QDRANT_URL 不是有效 HTTP(S) 地址'), { code: 'qdrant_url_invalid' }); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Object.assign(new Error('QDRANT_URL 需为 HTTP(S) 地址且不能包含账号或查询信息'), { code: 'qdrant_url_invalid' });
  }
  const key = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  let client = clientCache.get(key);
  if (!client) {
    client = new QdrantClient({ url: key, apiKey: String(process.env.QDRANT_API_KEY || '').trim() || undefined, timeout: 12_000 });
    clientCache.set(key, client);
  }
  return client;
}

export function literatureCollectionName(profileFingerprint: string, profileGeneration = 1) {
  if (!/^[a-f0-9]{64}$/.test(profileFingerprint) || !Number.isSafeInteger(profileGeneration) || profileGeneration < 1) throw new Error('Embedding 索引 profile 无效');
  return `ivd_lit_${profileFingerprint.slice(0, 12)}_g${profileGeneration}`;
}

export function deterministicPointId(profileId: string, chunkId: string, generationId: string) {
  const digest = createHash('sha256').update(`${profileId}\0${chunkId}\0${generationId}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50; digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

function validateCollectionName(name: string) {
  if (!COLLECTION.test(name)) throw new Error('文献向量集合名不属于本应用命名空间');
}

export async function ensureLiteratureCollection(name: string, dimensions: number, distance: string) {
  validateCollectionName(name);
  const client = qdrantClient();
  const exists = await client.collectionExists(name);
  if (exists.exists) {
    const info = await client.getCollection(name) as any;
    const config = info.config?.params?.vectors;
    const actualDimensions = Number(config?.size || 0);
    const actualDistance = String(config?.distance || '');
    if (actualDimensions !== dimensions || actualDistance !== distance) throw Object.assign(new Error('现有 Qdrant 集合的向量维度或距离度量与 profile 不匹配'), { code: 'qdrant_profile_mismatch' });
    return;
  }
  await client.createCollection(name, { vectors: { size: dimensions, distance: distance as any }, on_disk_payload: true });
}

export async function upsertLiteraturePoints(name: string, dimensions: number, distance: string, points: PointInput[]) {
  validateCollectionName(name);
  if (!points.length) return;
  await ensureLiteratureCollection(name, dimensions, distance);
  for (let offset = 0; offset < points.length; offset += 128) {
    const batch = points.slice(offset, offset + 128);
    await qdrantClient().upsert(name, { wait: true, points: batch as any });
  }
}

export async function queryLiteraturePoints(name: string, vector: number[], limit: number, itemIds: string[], generationIds: string[]) {
  validateCollectionName(name);
  if (!itemIds.length || !generationIds.length || !vector.length) return [];
  const result = await qdrantClient().query(name, {
    query: vector, limit: Math.max(1, Math.min(limit, 40)), with_payload: true, with_vector: false,
    filter: { must: [
      { key: 'item_id', match: { any: itemIds } },
      { key: 'generation_id', match: { any: generationIds } },
    ] },
  } as any) as any;
  return (result.points || []).map((point: any) => ({ id: String(point.id), score: Number(point.score), payload: point.payload || {} }));
}

export async function deleteLiteratureGeneration(name: string, generationId: string) {
  validateCollectionName(name);
  const exists = await qdrantClient().collectionExists(name);
  if (!exists.exists) return;
  await qdrantClient().delete(name, { wait: true, filter: { must: [{ key: 'generation_id', match: { value: generationId } }] } } as any);
}

export async function literatureVectorHealth() {
  try {
    const result = await qdrantClient().getCollections();
    return { status: 'connected', collectionCount: result.collections.length };
  } catch (error) {
    const code = String((error as any)?.code || 'qdrant_unavailable');
    return { status: 'unavailable', errorCode: code, message: (error as Error).message.slice(0, 250) };
  }
}

function validateReportCollectionName(name: string) {
  if (!REPORT_COLLECTION.test(name)) throw new Error('报告知识向量集合名不属于本应用独立命名空间');
}

export function reportKnowledgeCollectionName(profileFingerprint: string, profileGeneration = 1) {
  if (!/^[a-f0-9]{64}$/.test(profileFingerprint) || !Number.isSafeInteger(profileGeneration) || profileGeneration < 1) throw new Error('Embedding profile 无效');
  return `ivd_rpt_${profileFingerprint.slice(0, 12)}_g${profileGeneration}`;
}

export async function ensureReportKnowledgeCollection(name: string, dimensions: number, distance: string) {
  validateReportCollectionName(name);
  const client = qdrantClient();
  const exists = await client.collectionExists(name);
  if (exists.exists) {
    const info = await client.getCollection(name) as any;
    const config = info.config?.params?.vectors;
    if (Number(config?.size || 0) !== dimensions || String(config?.distance || '') !== distance) {
      throw Object.assign(new Error('报告知识 Qdrant 集合与 Embedding profile 的维度或距离度量不一致'), { code: 'qdrant_profile_mismatch' });
    }
    return;
  }
  await client.createCollection(name, { vectors: { size: dimensions, distance: distance as any }, on_disk_payload: true });
}

export async function upsertReportKnowledgePoints(name: string, dimensions: number, distance: string, points: PointInput[]) {
  validateReportCollectionName(name);
  if (!points.length) return;
  await ensureReportKnowledgeCollection(name, dimensions, distance);
  for (let offset = 0; offset < points.length; offset += 128) {
    await qdrantClient().upsert(name, { wait: true, points: points.slice(offset, offset + 128) as any });
  }
}

export async function queryReportKnowledgePoints(name: string, vector: number[], limit: number,
  scopes: Array<{ reportId: string; fingerprint: string }>) {
  validateReportCollectionName(name);
  if (!vector.length || !scopes.length) return [];
  const matches: Array<{ id: string; score: number; payload: Record<string, any> }> = [];
  for (let offset = 0; offset < scopes.length; offset += 128) {
    const batch = scopes.slice(offset, offset + 128);
    const result = await qdrantClient().query(name, { query: vector, limit: Math.max(1, Math.min(limit, 40)), with_payload: true, with_vector: false,
      filter: { should: batch.map(scope => ({ must: [
        { key: 'report_id', match: { value: scope.reportId } },
        { key: 'knowledge_fingerprint', match: { value: scope.fingerprint } },
      ] })) },
    } as any) as any;
    matches.push(...(result.points || []).map((point: any) => ({ id: String(point.id), score: Number(point.score), payload: point.payload || {} })));
  }
  const unique = new Map<string, { id: string; score: number; payload: Record<string, any> }>();
  for (const item of matches) if (!unique.has(item.id) || unique.get(item.id)!.score < item.score) unique.set(item.id, item);
  return [...unique.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 40)));
}

export async function deleteReportKnowledgePoints(name: string, reportId: string, exceptFingerprint?: string) {
  validateReportCollectionName(name);
  const exists = await qdrantClient().collectionExists(name);
  if (!exists.exists) return;
  const filter: Record<string, any> = { must: [{ key: 'report_id', match: { value: reportId } }] };
  if (exceptFingerprint) filter.must_not = [{ key: 'knowledge_fingerprint', match: { value: exceptFingerprint } }];
  await qdrantClient().delete(name, { wait: true, filter } as any);
}

export async function reportKnowledgePointsPresent(name: string, pointIds: string[]) {
  validateReportCollectionName(name);
  if (!pointIds.length) return true;
  const exists = await qdrantClient().collectionExists(name);
  if (!exists.exists) return false;
  for (let offset = 0; offset < pointIds.length; offset += 128) {
    const requested = pointIds.slice(offset, offset + 128);
    const rows = await qdrantClient().retrieve(name, { ids: requested, with_payload: false, with_vector: false } as any) as any[];
    const found = new Set(rows.map(row => String(row.id)));
    if (requested.some(pointId => !found.has(pointId))) return false;
  }
  return true;
}
