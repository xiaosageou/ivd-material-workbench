import { createHash } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { deleteLiteratureGeneration, ensureLiteratureCollection, literatureCollectionName, queryLiteraturePoints, upsertLiteraturePoints } from './literature/vector.ts';

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`LITERATURE QDRANT SMOKE FAIL: ${message}`); };
const url = String(process.env.QDRANT_URL || '').trim();
if (!url) throw new Error('LITERATURE QDRANT SMOKE requires explicit QDRANT_URL to a real Qdrant engine');
const profileHash = createHash('sha256').update(`isolated-qdrant-contract-${Date.now()}-${process.pid}`).digest('hex');
const name = literatureCollectionName(profileHash, 999);
const client = new QdrantClient({ url, apiKey: process.env.QDRANT_API_KEY || undefined, timeout: 12_000 });
const generationId = `test-generation-${process.pid}`;
const itemId = `test-item-${process.pid}`;

try {
  const health = await client.getCollections();
  assert(Array.isArray(health.collections), '真实引擎返回 collections');
  await ensureLiteratureCollection(name, 3, 'Cosine');
  const points = [
    { id: '4e6bea50-9d88-5d76-8b9b-506475e8c60b', vector: [1, 0, 0], payload: { item_id: itemId, generation_id: generationId, chunk_id: 'chunk-1' } },
    { id: '736e4c41-b49f-56c3-9496-a8c8dd0ffdf3', vector: [0, 1, 0], payload: { item_id: itemId, generation_id: `${generationId}-other`, chunk_id: 'chunk-2' } },
  ];
  await upsertLiteraturePoints(name, 3, 'Cosine', points);
  let found = await queryLiteraturePoints(name, [1, 0, 0], 10, [itemId], [generationId]);
  assert(found.length === 1 && found[0].payload.chunk_id === 'chunk-1', '真实 Qdrant 向量查询与 generation/item payload filter');
  await deleteLiteratureGeneration(name, generationId);
  found = await queryLiteraturePoints(name, [1, 0, 0], 10, [itemId], [generationId]);
  assert(found.length === 0, '真实 Qdrant 按 generation 删除后立即查询为空');
  console.log(`LITERATURE QDRANT SMOKE PASS: real engine ${url} · ${health.collections.length} pre-existing collections · ${name} create/upsert/query/filter/delete verified.`);
} finally {
  const exists = await client.collectionExists(name).catch(() => ({ exists: false }));
  if (exists.exists) await client.deleteCollection(name).catch(() => undefined);
}
import './test-isolation.mjs';
