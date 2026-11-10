import { db, id, transaction } from '../db.ts';
import { getActiveLiteratureProfile, getLiteratureEmbeddingConfig, getLiteratureEmbeddingStatus } from './embedding-config.ts';
import { embedOpenAiCompatible, EmbeddingRequestError } from './embedding-provider.ts';
import { listLiteratureRows, type LiteratureActor } from './repository.ts';
import { literatureCollectionName, queryLiteraturePoints } from './vector.ts';

type Row = Record<string, any>;
export type LiteratureScope = { itemIds?: string[]; collectionIds?: string[]; reportIds?: string[]; allowAll?: boolean };
type SearchOptions = { mode?: 'keyword'|'semantic'|'hybrid'; limit?: number; collectionId?: string; actor?: LiteratureActor;
  scope?: LiteratureScope; persistEvidence?: boolean };

const cleanIds = (items: unknown, cap = 5000) => [...new Set(Array.isArray(items) ? items.map(value => String(value).trim()).filter(Boolean) : [])].slice(0, cap);
const escLike = (value: string) => value.replace(/[\\%_]/g, token => `\\${token}`);

function scopeIds(scope: LiteratureScope | undefined) {
  if (!scope || scope.allowAll) return undefined;
  const items = cleanIds(scope.itemIds);
  const requestedCollections = cleanIds(scope.collectionIds);
  const collections = activeCollectionIds(requestedCollections);
  if (!items.length && !requestedCollections.length) return [] as string[];
  if (!requestedCollections.length) return activeItemIds(items);
  if (!collections.length) return [] as string[];
  const collectionItems = new Set<string>();
  for (let offset = 0; offset < collections.length; offset += 400) {
    const batch = collections.slice(offset, offset + 400);
    for (const row of db.prepare(`SELECT DISTINCT i.id FROM literature_items i JOIN literature_item_collections ic ON ic.item_id=i.id
      JOIN literature_collections c ON c.id=ic.collection_id AND c.deleted_at IS NULL
      WHERE i.deleted_at IS NULL AND c.id IN (${batch.map(() => '?').join(',')}) ORDER BY i.id`).all(...batch) as Row[]) {
      collectionItems.add(String(row.id));
    }
  }
  const matchedItems = [...collectionItems];
  if (!items.length) return matchedItems;
  const wanted = new Set(items); return matchedItems.filter(itemId => wanted.has(itemId));
}

function activeCollectionIds(collectionIds: string[]) {
  const active = new Set<string>();
  for (let offset = 0; offset < collectionIds.length; offset += 400) {
    const batch = collectionIds.slice(offset, offset + 400);
    for (const row of db.prepare(`SELECT id FROM literature_collections WHERE deleted_at IS NULL AND id IN (${batch.map(() => '?').join(',')})`)
      .all(...batch) as Row[]) active.add(String(row.id));
  }
  return collectionIds.filter(id => active.has(id));
}

function activeItemIds(itemIds: string[]) {
  const active = new Set<string>();
  for (let offset = 0; offset < itemIds.length; offset += 400) {
    const batch = itemIds.slice(offset, offset + 400);
    for (const row of db.prepare(`SELECT id FROM literature_items WHERE deleted_at IS NULL AND id IN (${batch.map(() => '?').join(',')})`)
      .all(...batch) as Row[]) active.add(String(row.id));
  }
  return itemIds.filter(id => active.has(id));
}

/** Checks current active membership without treating a truncated listing as an authorization set. */
export function isLiteratureInScope(scope: LiteratureScope | undefined, itemIdRaw: unknown) {
  const itemId = String(itemIdRaw || '').trim();
  if (!scope || !itemId) return false;
  if (scope.allowAll) return Boolean(db.prepare('SELECT 1 FROM literature_items WHERE id=? AND deleted_at IS NULL').get(itemId));
  const items = cleanIds(scope.itemIds);
  const requestedCollections = cleanIds(scope.collectionIds);
  const collections = activeCollectionIds(requestedCollections);
  if (!items.length && !requestedCollections.length) return false;
  if (requestedCollections.length && !collections.length) return false;
  if (items.length && !items.includes(itemId)) return false;
  if (!requestedCollections.length) return Boolean(db.prepare('SELECT 1 FROM literature_items WHERE id=? AND deleted_at IS NULL').get(itemId));
  for (let offset = 0; offset < collections.length; offset += 400) {
    const batch = collections.slice(offset, offset + 400);
    const found = db.prepare(`SELECT 1 FROM literature_items i JOIN literature_item_collections ic ON ic.item_id=i.id
      JOIN literature_collections c ON c.id=ic.collection_id AND c.deleted_at IS NULL
      WHERE i.id=? AND i.deleted_at IS NULL AND c.id IN (${batch.map(() => '?').join(',')}) LIMIT 1`).get(itemId, ...batch);
    if (found) return true;
  }
  return false;
}

function collectionFilter(ids: string[], collectionId: string) {
  if (!collectionId) return ids;
  const collectionItems = db.prepare('SELECT item_id FROM literature_item_collections WHERE collection_id=?').all(collectionId).map((row: any) => String(row.item_id));
  const allowed = new Set(collectionItems);
  return ids.filter(itemId => allowed.has(itemId));
}

function keywordChunks(query: string, itemIds: string[], limit: number) {
  if (!query || !itemIds.length) return [] as Row[];
  const escaped = `%${escLike(query)}%`;
  const matches: Row[] = [];
  for (let offset = 0; offset < itemIds.length; offset += 400) {
    const batch = itemIds.slice(offset, offset + 400);
    if (query.length >= 3) {
      try {
        const match = `"${query.replaceAll('"', '""')}"`;
        matches.push(...db.prepare(`SELECT c.id AS chunk_id,c.item_id,c.version_id,c.source_extent,c.locator_json,c.section_title,c.content_text,c.content_sha256
          FROM literature_chunks_fts f JOIN literature_chunks c ON c.id=f.chunk_id JOIN literature_items i ON i.id=c.item_id
          WHERE literature_chunks_fts MATCH ? AND c.item_id IN (${batch.map(() => '?').join(',')}) AND i.deleted_at IS NULL
            AND c.version_id IS i.current_version_id AND (c.extraction_id IS NOT NULL OR c.metadata_revision=i.revision)
          ORDER BY c.item_id,c.sequence_no LIMIT ?`).all(match, ...batch, limit) as Row[]);
        continue;
      } catch { /* Bound LIKE fallback supports punctuation and older SQLite builds. */ }
    }
    matches.push(...db.prepare(`SELECT c.id AS chunk_id,c.item_id,c.version_id,c.source_extent,c.locator_json,c.section_title,c.content_text,c.content_sha256
      FROM literature_chunks c JOIN literature_items i ON i.id=c.item_id
      WHERE c.item_id IN (${batch.map(() => '?').join(',')}) AND i.deleted_at IS NULL AND c.version_id IS i.current_version_id
        AND (c.extraction_id IS NOT NULL OR c.metadata_revision=i.revision) AND c.content_text LIKE ? ESCAPE '\\'
      ORDER BY c.item_id,c.sequence_no LIMIT ?`).all(...batch, escaped, limit) as Row[]);
  }
  return matches;
}

function currentChunk(point: Row, profileId: string) {
  const chunkId = String(point.payload?.chunk_id || '');
  const row = db.prepare(`SELECT c.*,i.title,i.authors_json,i.publication_year,i.journal,i.doi,i.pmid,i.current_version_id,i.revision,
      v.sha256 AS current_sha256,g.id AS live_generation,g.collection_name,g.profile_id
    FROM literature_chunks c JOIN literature_items i ON i.id=c.item_id
    JOIN literature_index_generations g ON g.id=? AND g.item_id=c.item_id AND g.status='ready'
    JOIN literature_embedding_profiles p ON p.id=g.profile_id AND p.active=1
    LEFT JOIN literature_file_versions v ON v.id=i.current_version_id
    WHERE c.id=? AND i.deleted_at IS NULL AND i.current_version_id IS g.version_id AND c.version_id IS g.version_id
      AND g.profile_id=? AND c.content_sha256=? AND c.id IN (SELECT chunk_id FROM literature_embedding_cache WHERE chunk_id=c.id AND profile_id=g.profile_id)
      AND (c.extraction_id IS NOT NULL OR c.metadata_revision=i.revision)
    LIMIT 1`).get(String(point.payload?.generation_id || ''), chunkId, profileId, String(point.payload?.content_sha256 || '')) as Row | undefined;
  if (!row || String(point.payload?.item_id || '') !== String(row.item_id) || String(point.payload?.profile_id || '') !== profileId) return undefined;
  return row;
}

function createEvidence(row: Row, profileId?: string) {
  const refId = id('litev_');
  db.prepare(`INSERT INTO literature_evidence_refs(id,item_id,version_id,chunk_id,extraction_sha256,content_sha256,profile_id,locator_json,excerpt,source_extent,created_by,metadata_revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(refId, row.item_id, row.version_id || null, row.chunk_id || row.chunkId || row.id,
      String(row.current_sha256 || ''), String(row.content_sha256), profileId || null, String(row.locator_json || '{}'), String(row.content_text).slice(0, 600),
      row.source_extent, String(row.created_by || ''), Number(row.metadata_revision || row.revision || 0));
  return refId;
}

export function readCurrentLiteratureEvidence(evidenceId: string) {
  const ref = db.prepare(`SELECT e.*,i.title,i.authors_json,i.publication_year,i.journal,i.doi,i.pmid,i.deleted_at,i.current_version_id,
      v.sha256 AS current_sha256,u.name AS creator_name,c.content_text,c.content_sha256 AS chunk_sha256,c.locator_json AS current_locator,i.revision,
      ex.coverage_json AS extraction_coverage,ex.status AS extraction_status
    FROM literature_evidence_refs e JOIN literature_items i ON i.id=e.item_id
    LEFT JOIN literature_file_versions v ON v.id=i.current_version_id LEFT JOIN users u ON u.id=i.created_by
    LEFT JOIN literature_chunks c ON c.id=e.chunk_id LEFT JOIN literature_extractions ex ON ex.id=c.extraction_id WHERE e.id=?`).get(evidenceId) as Row | undefined;
  if (!ref || ref.deleted_at || (ref.version_id && ref.version_id !== ref.current_version_id)
    || (ref.version_id && ref.extraction_sha256 && ref.extraction_sha256 !== ref.current_sha256)
    || (['metadata','abstract'].includes(String(ref.source_extent)) && Number(ref.metadata_revision) !== Number(ref.revision))
    || !ref.content_text || ref.chunk_sha256 !== ref.content_sha256) return undefined;
  const coverage = ref.extraction_coverage ? JSON.parse(String(ref.extraction_coverage)) : null;
  const pagesWithoutText = Array.isArray(coverage?.pagesWithoutText) ? coverage.pagesWithoutText : [];
  return { refId: evidenceId, sourceType: 'literature', itemId: String(ref.item_id), literatureId: String(ref.item_id), title: String(ref.title),
    authors: JSON.parse(String(ref.authors_json || '[]')), publicationYear: ref.publication_year, journal: String(ref.journal || ''), doi: String(ref.doi || ''),
    pmid: String(ref.pmid || ''), versionId: ref.version_id ? String(ref.version_id) : null, chunkId: String(ref.chunk_id),
    contentSha256: String(ref.content_sha256), sourceExtent: String(ref.source_extent), locator: JSON.parse(String(ref.current_locator || ref.locator_json || '{}')),
    text: String(ref.content_text), currentSha256: String(ref.current_sha256 || ''), creatorName: String(ref.creator_name || ''),
    extractionStatus: ref.extraction_status || null, coverage, coverageNotice: pagesWithoutText.length
      ? `源 PDF 第 ${pagesWithoutText.join('、')} 页没有可提取文本层，内容可能为空白或扫描页；该证据不覆盖这些页面。` : '' };
}

function beginQuery(ownerId: string, profileId: string, config: ReturnType<typeof getLiteratureEmbeddingConfig>) {
  const date = new Date().toISOString().slice(0, 10);
  return transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO literature_query_usage(owner_id,profile_id,usage_date,token_budget,request_budget)
      VALUES (?,?,?,?,?)`).run(ownerId, profileId, date, config.queryTokenBudget, config.queryMaxRequests);
    const usage = db.prepare('SELECT * FROM literature_query_usage WHERE owner_id=? AND profile_id=? AND usage_date=?').get(ownerId, profileId, date) as Row;
    if (Number(usage.unknown_count) > 0 || Number(usage.pending_count) > 0) return { ok: false as const, reason: 'query_usage_unknown' };
    if (Number(usage.request_count) >= Number(usage.request_budget)) return { ok: false as const, reason: 'query_request_budget' };
    if (Number(usage.used_tokens) >= Number(usage.token_budget)) return { ok: false as const, reason: 'query_token_budget' };
    db.prepare(`UPDATE literature_query_usage SET request_count=request_count+1,pending_count=pending_count+1,updated_at=datetime('now')
      WHERE owner_id=? AND profile_id=? AND usage_date=?`).run(ownerId, profileId, date);
    return { ok: true as const, date };
  });
}

function settleQuery(ownerId: string, profileId: string, date: string, usage: { status: 'known'|'unknown'; totalTokens: number|null }, reason = '') {
  db.prepare(`UPDATE literature_query_usage SET pending_count=MAX(0,pending_count-1),used_tokens=used_tokens+?,unknown_count=unknown_count+?,
    usage_status=CASE WHEN unknown_count+?>0 THEN CASE WHEN used_tokens+?>0 THEN 'partial_unknown' ELSE 'unknown' END ELSE 'known' END,
    stop_reason=?,updated_at=datetime('now') WHERE owner_id=? AND profile_id=? AND usage_date=?`)
    .run(usage.status === 'known' ? Number(usage.totalTokens || 0) : 0, usage.status === 'unknown' ? 1 : 0,
      usage.status === 'unknown' ? 1 : 0, usage.status === 'known' ? Number(usage.totalTokens || 0) : 0, reason,
      ownerId, profileId, date);
}

export { beginQuery as beginLiteratureQueryUsage, settleQuery as settleLiteratureQueryUsage };

function rankedKeyword(query: string, itemRows: Row[], itemIds: string[], limit: number, persistEvidence: boolean, actorId = ''): Row[] {
  const chunks = keywordChunks(query, itemIds, Math.min(400, limit * 10));
  const items = new Map(itemRows.map(row => [String(row.id), row]));
  const output: Row[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const item = items.get(String(chunk.item_id));
    if (!item || seen.has(String(chunk.chunk_id))) continue;
    seen.add(String(chunk.chunk_id));
    const text = `${item.title} ${item.authors_json} ${item.doi} ${item.abstract} ${item.keywords_json}`.toLocaleLowerCase();
    const q = query.toLocaleLowerCase();
    const metadataBoost = String(item.doi || '').toLocaleLowerCase() === q ? 8 : String(item.title).toLocaleLowerCase().includes(q) ? 5
      : String(item.authors_json).toLocaleLowerCase().includes(q) ? 3 : text.includes(q) ? 2 : 0;
    const literatureId = String(item.id);
    output.push({ ...item, id: literatureId, literatureId, itemId: literatureId, chunkId: String(chunk.chunk_id), sourceExtent: chunk.source_extent, locator: JSON.parse(String(chunk.locator_json)),
      excerpt: String(chunk.content_text), keywordScore: 10 + metadataBoost, rank: output.length + 1,
      evidenceRefId: persistEvidence ? createEvidence({ ...chunk, revision: item.revision, current_sha256: item.current_sha256, created_by: actorId }, undefined) : undefined });
  }
  return output.sort((a, b) => b.keywordScore - a.keywordScore).slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function searchLiterature(queryRaw: unknown, options: SearchOptions = {}): Promise<{ mode: string; fallbackReason: string; results: Row[]; usage: Row | null }> {
  const query = String(queryRaw || '').trim().slice(0, 1000);
  if (!query) return { mode: 'keyword', fallbackReason: '', results: [] as Row[], usage: null };
  const requestedMode = options.mode || 'hybrid';
  const limit = Math.max(1, Math.min(10, Number(options.limit || 10)));
  const scope = options.scope;
  const scoped = Boolean(scope && scope.allowAll !== true);
  const scopeItemIds = scoped && Array.isArray(scope?.itemIds) ? cleanIds(scope.itemIds) : undefined;
  const scopeCollectionIds = scoped && Array.isArray(scope?.collectionIds) ? cleanIds(scope.collectionIds) : undefined;
  if (scoped && !scopeItemIds?.length && !scopeCollectionIds?.length) return { mode: 'keyword', fallbackReason: '此会话没有选择可检索的文献；空范围不会扩展到整个知识库。', results: [] as Row[], usage: null };
  const actor = options.actor || { id: '', role: 'RESEARCHER' };
  const itemRows = listLiteratureRows({ q: '', collectionId: options.collectionId, actorId: actor.id, role: actor.role, unbounded: true,
    scopeItemIds: scopeItemIds?.length ? scopeItemIds : undefined, scopeCollectionIds: scopeCollectionIds?.length ? scopeCollectionIds : undefined });
  const itemIds = itemRows.map(row => String(row.id));
  if (scoped && !itemRows.length) return { mode: 'keyword', fallbackReason: '所选范围内没有可检索文献。', results: [], usage: null };
  const keyword = rankedKeyword(query, itemRows, itemIds, 40, options.persistEvidence === true && requestedMode === 'keyword', actor.id);
  if (requestedMode === 'keyword') return { mode: 'keyword', fallbackReason: '', results: keyword.slice(0, limit), usage: null };

  const status = getLiteratureEmbeddingStatus();
  const profile = getActiveLiteratureProfile();
  if (!profile || status.embedding.status !== 'configured' || status.qdrant.status !== 'configured') {
    return { mode: 'keyword', fallbackReason: 'Embedding 或 Qdrant 未配置；本次已降级为关键词检索。', results: keyword.slice(0, limit), usage: null };
  }
  const generationRows: Row[] = [];
  for (let offset = 0; offset < itemIds.length; offset += 400) {
    const batch = itemIds.slice(offset, offset + 400);
    generationRows.push(...db.prepare(`SELECT g.id,g.item_id,g.version_id,g.collection_name FROM literature_index_generations g
      JOIN literature_items i ON i.id=g.item_id JOIN literature_embedding_profiles p ON p.id=g.profile_id
      WHERE g.profile_id=? AND g.status='ready' AND p.active=1 AND i.deleted_at IS NULL AND i.current_version_id IS g.version_id
        AND i.id IN (${batch.map(() => '?').join(',')}) ORDER BY g.item_id,g.generation_no DESC`).all(profile.id, ...batch) as Row[]);
  }
  const latest = new Map<string, Row>();
  for (const generation of generationRows) if (!latest.has(String(generation.item_id))) latest.set(String(generation.item_id), generation);
  const gens = [...latest.values()];
  if (!gens.length) return { mode: 'keyword', fallbackReason: '所选文献尚无当前版本的已发布向量索引；本次使用关键词检索。', results: keyword.slice(0, limit), usage: null };

  const begin = beginQuery(actor.id, String(profile.id), getLiteratureEmbeddingConfig());
  if (!begin.ok) return { mode: 'keyword', fallbackReason: begin.reason === 'query_usage_unknown' ? '本日文献查询用量存在未确认请求；为避免重复计费，语义请求已停止并降级为关键词。'
    : begin.reason === 'query_request_budget' ? '已达到本日语义查询请求数上限；本次使用关键词检索。' : '已达到本日语义查询 token 预算；本次使用关键词检索。',
    results: keyword.slice(0, limit), usage: { status: begin.reason } };
  const config = getLiteratureEmbeddingConfig();
  const embeddingProfile = { baseUrl: config.baseUrl, model: config.model, dimensions: Number(profile.dimensions), sendDimensions: config.sendDimensions,
    maxInputChars: config.maxInputChars, timeoutMs: config.timeoutMs };
  let vectorResult;
  let settled = false;
  try {
    vectorResult = await embedOpenAiCompatible([`${String(profile.query_prefix || '')}${query}`], embeddingProfile);
    settleQuery(actor.id, String(profile.id), begin.date, vectorResult.usage);
    settled = true;
  } catch (error) {
    const failure = error instanceof EmbeddingRequestError ? error : undefined;
    settleQuery(actor.id, String(profile.id), begin.date, { status: failure?.usageOutcome === 'rejected' ? 'known' : 'unknown', totalTokens: null }, failure?.code || 'query_embedding_unknown');
    settled = true;
    return { mode: 'keyword', fallbackReason: failure?.usageOutcome === 'rejected' ? 'Embedding 服务拒绝本次查询；本次已降级为关键词。'
      : 'Embedding 查询用量未知；本日后续语义请求已停止，本次降级为关键词。', results: keyword.slice(0, limit), usage: { status: failure?.usageOutcome || 'unknown' } };
  }
  if ((vectorResult.model && vectorResult.model !== config.model) || vectorResult.usage.status !== 'known') {
    if (vectorResult.usage.status !== 'known' && settled) {
      db.prepare(`UPDATE literature_query_usage SET unknown_count=MAX(unknown_count,1),usage_status=CASE WHEN used_tokens>0 THEN 'partial_unknown' ELSE 'unknown' END,
        stop_reason='query_usage_missing',updated_at=datetime('now') WHERE owner_id=? AND profile_id=? AND usage_date=?`)
        .run(actor.id, profile.id, begin.date);
    }
    return { mode: 'keyword', fallbackReason: vectorResult.usage.status === 'unknown' ? 'Embedding 未返回可核验用量；本日后续语义请求已停止，本次降级为关键词。'
      : 'Embedding 响应模型与活动 profile 不符；本次降级为关键词。', results: keyword.slice(0, limit), usage: { status: vectorResult.usage.status } };
  }

  const vectorByChunk = new Map<string, { row: Row; score: number }>();
  const collectionName = literatureCollectionName(String(profile.fingerprint), Number(profile.generation));
  try {
    for (let i = 0; i < gens.length; i += 100) {
      const subset = gens.slice(i, i + 100);
      const points = await queryLiteraturePoints(collectionName, vectorResult.vectors[0], 40, subset.map(row => String(row.item_id)), subset.map(row => String(row.id)));
      for (const point of points) {
        const row = currentChunk(point, String(profile.id));
        if (!row || !subset.some(generation => String(generation.id) === String(point.payload?.generation_id))) continue;
        const item = itemRows.find(candidate => String(candidate.id) === String(row.item_id));
        if (!item) continue;
        const literatureId = String(row.item_id);
        const full = { ...item, ...row, id: literatureId, itemId: literatureId, literatureId, chunkId: String(row.id),
          locator: JSON.parse(String(row.locator_json)), excerpt: String(row.content_text), vectorScore: point.score };
        vectorByChunk.set(String(row.id), { row: full, score: Number(point.score) });
      }
    }
  } catch {
    return { mode: 'keyword', fallbackReason: 'Qdrant 当前不可用；本次 Embedding 请求已按实际用量记录，并退回关键词检索。',
      results: keyword.slice(0, limit), usage: { status: 'known', requestCounted: true, tokens: vectorResult.usage.totalTokens, responseId: vectorResult.usage.responseId } };
  }
  const vectorResults: Row[] = [...vectorByChunk.values()].sort((a, b) => b.score - a.score).slice(0, 40).map((item, index): Row => ({
    ...item.row, vectorRank: index + 1, retrieval: 'semantic' }));
  const semanticResults: Row[] = [];
  const semanticPerItem = new Map<string, number>();
  for (const row of vectorResults) {
    const itemId = String(row.literatureId || row.itemId || row.item_id);
    const count = semanticPerItem.get(itemId) || 0;
    if (count >= 3) continue;
    semanticPerItem.set(itemId, count + 1);
    semanticResults.push({ ...row, rank: semanticResults.length + 1 });
  }
  if (requestedMode === 'semantic') {
    const results = semanticResults.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1,
      evidenceRefId: options.persistEvidence ? createEvidence({ ...row, created_by: actor.id }, String(profile.id)) : undefined }));
    return results.length ? { mode: 'semantic', fallbackReason: '', results,
      usage: { status: 'known', requestCounted: true, tokens: vectorResult.usage.totalTokens, responseId: vectorResult.usage.responseId } }
      : { mode: 'keyword', fallbackReason: '语义索引没有通过当前版本与 SHA 校验的结果；本次仅返回关键词匹配。', results: keyword.slice(0, limit),
        usage: { status: 'known', requestCounted: true, tokens: vectorResult.usage.totalTokens, responseId: vectorResult.usage.responseId } };
  }
  const keywordRank = new Map(keyword.map((row, index) => [String(row.chunkId), index + 1]));
  const vectorRank = new Map(semanticResults.map((row, index) => [String(row.chunkId), index + 1]));
  const all = new Map<string, Row>();
  for (const row of [...keyword, ...semanticResults]) all.set(String(row.chunkId), row);
  const fused: Row[] = [...all.values()].map((row): Row => ({ ...row, rrfScore: (keywordRank.has(String(row.chunkId)) ? 1 / (60 + keywordRank.get(String(row.chunkId))!) : 0)
    + (vectorRank.has(String(row.chunkId)) ? 1 / (60 + vectorRank.get(String(row.chunkId))!) : 0),
    retrieval: keywordRank.has(String(row.chunkId)) && vectorRank.has(String(row.chunkId)) ? 'hybrid' : vectorRank.has(String(row.chunkId)) ? 'semantic' : 'keyword' }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
  const perItem = new Map<string, number>();
  const results: Row[] = [];
  for (const row of fused) {
    const literatureId = String(row.literatureId || row.itemId || row.id);
    const count = perItem.get(literatureId) || 0;
    if (count >= 3) continue;
    perItem.set(literatureId, count + 1);
    if (options.persistEvidence) row.evidenceRefId = createEvidence({ ...row, created_by: actor.id }, String(profile.id));
    results.push(row);
    if (results.length >= limit) break;
  }
  return { mode: vectorResults.length ? requestedMode : 'keyword', fallbackReason: vectorResults.length ? '' : '语义索引没有通过当前版本与 SHA 校验的结果；本次仅返回关键词匹配。',
    results, usage: { status: 'known', requestCounted: true, tokens: vectorResult.usage.totalTokens, responseId: vectorResult.usage.responseId } };
}

export function resolveLiteratureScope(scope: LiteratureScope | undefined) {
  if (!scope) return [] as string[];
  const ids = scopeIds(scope);
  return ids ?? db.prepare('SELECT id FROM literature_items WHERE deleted_at IS NULL ORDER BY id').all().map((row: any) => String(row.id));
}
