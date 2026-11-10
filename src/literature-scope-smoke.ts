import assert from 'node:assert/strict';
import { db, id } from './db.ts';
import { buildCurrentPiHistory, createAssistantSession, enqueueChatMessage, getAssistantSession } from './ai/chat.ts';
import { runAiWorkerOnce } from './ai/worker.ts';
import { buildAssistantTools } from './ai/tools.ts';
import { createCollection, createLiteratureRecord, deleteCollection, setLiteratureDeleted, updateLiteratureMetadata } from './literature/repository.ts';
import { isLiteratureInScope, resolveLiteratureScope, searchLiterature } from './literature/search.ts';

type ToolRow = { name: string; execute: (...args: any[]) => Promise<any> };
const actor = { id: 'literature-scope-admin', role: 'ADMIN' };
const parseTool = (value: any) => JSON.parse(String(value.content?.find((block: any) => block.type === 'text')?.text || '{}'));
const executeTool = (tools: ToolRow[], name: string, args: Record<string, unknown>) => {
  const selected = tools.find(item => item.name === name);
  assert(selected, `assistant tool ${name} exists`);
  return selected.execute(`scope-smoke-${name}`, args, new AbortController().signal, () => {});
};
const expectThrows = async (run: () => unknown | Promise<unknown>, message: RegExp) => {
  let caught: unknown;
  try { await run(); } catch (error) { caught = error; }
  assert(caught instanceof Error, 'expected operation to reject');
  assert.match(caught.message, message);
};

try {
  db.prepare("INSERT INTO users(id,name,email,password_hash,role) VALUES(?,?,?,?, 'ADMIN')")
    .run(actor.id, '范围验收管理员', 'literature-scope-admin@example.test', 'fixture-only');
  process.env.IVD_AI_API_KEY = 'synthetic-only-invalid-key';
  db.prepare(`INSERT INTO system_settings(setting_key,setting_value,updated_by) VALUES ('ai_config',?,?)`).run(JSON.stringify({
    provider: 'openai-compatible', model: 'synthetic-model', baseUrl: 'http://fixture.invalid/v1', autoArchive: true,
    maxTokens: 1024, taskTokenBudget: 4096, timeoutMs: 5000, maxToolCalls: 4,
  }), actor.id);

  for (let index = 0; index < 501; index++) {
    createLiteratureRecord(actor, { title: `Scope baseline ${String(index).padStart(3, '0')}`, abstract: 'ordinary synthetic summary' });
  }
  const allScope = { allowAll: true };
  const orderedItems = db.prepare('SELECT * FROM literature_items WHERE deleted_at IS NULL ORDER BY id').all() as Record<string, any>[];
  assert.equal(orderedItems.length, 501, 'test keeps all 501 active literature records');
  const targetId = String(orderedItems[500].id);
  assert.equal(resolveLiteratureScope(allScope).length, 501, 'all-scope compatibility list is complete beyond 500');
  const omitted = orderedItems[500];
  assert(isLiteratureInScope(allScope, targetId), 'allowAll membership checks the live item directly beyond 500');
  const targetTitle = 'UniqueScopeTargetQxZ501';
  updateLiteratureMetadata(actor, omitted, { title: targetTitle, abstract: 'UniqueScopeTargetQxZ501 synthetic target evidence.' });

  const allSearch = await searchLiterature(targetTitle, { mode: 'keyword', scope: allScope, actor, persistEvidence: true });
  const targetHit = allSearch.results.find(row => String(row.itemId || row.literatureId) === targetId);
  assert(targetHit?.evidenceRefId, 'all-library search returns a persisted reference for the record beyond the old 500 boundary');
  const evidenceRefId = String(targetHit.evidenceRefId);
  const allTools = buildAssistantTools({ jobId: 'literature-scope-direct', contextType: 'knowledge_base', contextIds: [], literatureScope: allScope, actor });
  const read = parseTool(await executeTool(allTools, 'read_literature_evidence', { evidenceRefId }));
  assert.equal(read.itemId, targetId, 'read evidence accepts the exact searched all-library hit beyond 500');
  const metadata = parseTool(await executeTool(allTools, 'get_literature_metadata', { literatureId: targetId }));
  assert.equal(metadata.id, targetId, 'metadata tool accepts the same all-library item beyond 500');

  const explicitItemScope = { itemIds: [targetId] };
  const outsideItemId = String(orderedItems[0].id);
  assert(isLiteratureInScope(explicitItemScope, targetId), 'explicit item scope accepts its selected item');
  assert(!isLiteratureInScope(explicitItemScope, outsideItemId), 'explicit item scope rejects an unselected item');
  const explicitTools = buildAssistantTools({ jobId: 'literature-scope-explicit', contextType: 'knowledge_base', contextIds: [], literatureScope: explicitItemScope, actor });
  const outsideSearch = await searchLiterature(String(orderedItems[0].title), { mode: 'keyword', scope: explicitItemScope, actor, persistEvidence: true });
  assert.equal(outsideSearch.results.length, 0, 'explicit item scope does not expand search to unrelated records');
  await expectThrows(() => executeTool(explicitTools, 'get_literature_metadata', { literatureId: outsideItemId }), /不在本会话上下文内/);

  const sessionId = createAssistantSession(actor.id, 'knowledge_base', [], '全库范围越界回归', {
    type: 'reports_literature', literatureIds: [], reportIds: [], allowAll: true,
  });
  const firstMessage = enqueueChatMessage(sessionId, actor.id, `读取 ${targetTitle}`);
  let workerHistory: Array<{ role: string; content: string }> = [];
  const scopedRunner = async (options: any) => {
    workerHistory = options.history || [];
    const searchPayload = parseTool(await executeTool(options.tools, 'search_literature', { query: targetTitle, mode: 'keyword', limit: 10 }));
    const workerHit = searchPayload.results.find((row: any) => String(row.itemId || row.literatureId) === targetId);
    assert(workerHit?.evidenceRefId, 'worker search includes the 501st literature item');
    const workerEvidence = parseTool(await executeTool(options.tools, 'read_literature_evidence', { evidenceRefId: String(workerHit.evidenceRefId) }));
    assert.equal(workerEvidence.itemId, targetId, 'worker can read the exact 501st-item reference');
    return { text: `已核对 ${targetTitle} 的合成证据。`, toolCalls: 2, messages: [] };
  };
  assert(await runAiWorkerOnce({ runAgent: scopedRunner as any }), 'synthetic worker completes with all-library evidence');
  equalJobStatus(firstMessage.jobId, 'completed');
  const firstSession = getAssistantSession(sessionId, actor.id)!;
  const firstAssistant = firstSession.messages.find(message => message.jobId === firstMessage.jobId)!;
  const workerCitation = firstAssistant.citations.find((citation: any) => citation.evidenceRefId === evidenceRefId || citation.literatureId === targetId);
  assert(workerCitation?.valid, 'worker citation and current-session view keep the 501st-item citation valid');
  assert(workerHistory.length === 0, 'first worker starts with no earlier message history');

  const followup = enqueueChatMessage(sessionId, actor.id, '继续根据刚才引用的文献回答');
  let followupHistory: Array<{ role: string; content: string }> = [];
  const followupRunner = async (options: any) => { followupHistory = options.history || []; return { text: '继续回答。', toolCalls: 0, messages: [] }; };
  assert(await runAiWorkerOnce({ runAgent: followupRunner as any }),
    'synthetic follow-up worker runs');
  equalJobStatus(followup.jobId, 'completed');
  assert(followupHistory.some(row => row.role === 'assistant' && row.content.includes(targetTitle)), 'worker history retains valid all-library citation content');
  const directHistory = buildCurrentPiHistory([{ role: 'assistant', content_text: `已核对 ${targetTitle} 的合成证据。`, citations_json: JSON.stringify([
    { sourceType: 'literature', evidenceRefId, literatureId: targetId },
  ]) }], 'knowledge_base', [], allScope);
  assert(directHistory[0]?.content.includes(targetTitle), 'history builder retains current evidence outside the old 500-row window');

  const emptyTools = buildAssistantTools({ jobId: 'literature-scope-empty', contextType: 'knowledge_base', contextIds: [], literatureScope: { itemIds: [] }, actor });
  const emptySearch = parseTool(await executeTool(emptyTools, 'search_literature', { query: targetTitle, mode: 'keyword' }));
  assert.equal(emptySearch.results.length, 0, 'explicit empty item scope returns no search results');
  await expectThrows(() => executeTool(emptyTools, 'read_literature_evidence', { evidenceRefId }), /本会话没有显式选择文献范围|不在本会话上下文内/);
  await expectThrows(() => executeTool(emptyTools, 'get_literature_metadata', { literatureId: targetId }), /不在本会话上下文内/);

  const collectionId = createCollection(actor, 'Scope smoke collection');
  const collectionItemId = createLiteratureRecord(actor, { title: 'CollectionScopeUniqueQxZ', abstract: 'CollectionScopeUniqueQxZ evidence.', collectionIds: [collectionId] });
  const collectionScope = { collectionIds: [collectionId] };
  const collectionSearch = await searchLiterature('CollectionScopeUniqueQxZ', { mode: 'keyword', scope: collectionScope, actor, persistEvidence: true });
  const collectionHit = collectionSearch.results.find(row => String(row.itemId || row.literatureId) === collectionItemId);
  assert(collectionHit?.evidenceRefId, 'selected active collection grants search access to its item');
  const collectionTools = buildAssistantTools({ jobId: 'literature-scope-collection', contextType: 'knowledge_base', contextIds: [], literatureScope: collectionScope, actor });
  assert.equal(parseTool(await executeTool(collectionTools, 'read_literature_evidence', { evidenceRefId: String(collectionHit.evidenceRefId) })).itemId, collectionItemId,
    'selected active collection grants evidence read access');
  const collectionRow = db.prepare('SELECT * FROM literature_collections WHERE id=?').get(collectionId) as Record<string, any>;
  deleteCollection(actor, collectionRow);
  const archivedSearch = await searchLiterature('CollectionScopeUniqueQxZ', { mode: 'keyword', scope: collectionScope, actor, persistEvidence: true });
  assert.equal(archivedSearch.results.length, 0, 'archived collection no longer grants search access');
  const archivedIntersection = { itemIds: [collectionItemId], collectionIds: [collectionId] };
  assert(!isLiteratureInScope(archivedIntersection, collectionItemId), 'an archived collection cannot be bypassed by an explicit item overlap');
  const archivedIntersectionTools = buildAssistantTools({ jobId: 'literature-scope-archived-intersection', contextType: 'knowledge_base', contextIds: [], literatureScope: archivedIntersection, actor });
  await expectThrows(() => executeTool(archivedIntersectionTools, 'read_literature_evidence', { evidenceRefId: String(collectionHit.evidenceRefId) }), /不在本会话上下文内/);
  await expectThrows(() => executeTool(collectionTools, 'get_literature_metadata', { literatureId: collectionItemId }), /不在本会话上下文内/);

  const targetRow = db.prepare('SELECT * FROM literature_items WHERE id=?').get(targetId) as Record<string, any>;
  setLiteratureDeleted(actor, targetRow, true);
  await expectThrows(() => executeTool(allTools, 'read_literature_evidence', { evidenceRefId }), /文献证据已失效或不在本会话上下文内/);
  await expectThrows(() => executeTool(allTools, 'get_literature_metadata', { literatureId: targetId }), /文献不在本会话上下文内/);
  assert.equal(getAssistantSession(sessionId, actor.id)!.messages.find(message => message.jobId === firstMessage.jobId)!.citations
    .find((citation: any) => citation.literatureId === targetId)?.valid, false, 'deleted literature invalidates the saved session citation');
  const deletedHistory = buildCurrentPiHistory([{ role: 'assistant', content_text: `已核对 ${targetTitle} 的合成证据。`, citations_json: JSON.stringify([
    { sourceType: 'literature', evidenceRefId, literatureId: targetId },
  ]) }], 'knowledge_base', [], allScope);
  assert(deletedHistory[0]?.content.includes('失效事实已从本轮上下文排除'), 'deleted literature is filtered from future model history');

  process.stdout.write('LITERATURE SCOPE PASS: 501-item all-scope search/read/metadata/worker/current-session/history; empty scope, active/archived collection, and deletion checks.\n');
} finally {
  db.close();
}

function equalJobStatus(jobId: string, expected: string) {
  const row = db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(jobId) as Record<string, any> | undefined;
  assert.equal(row?.status, expected, `AI job ${jobId} has status ${expected}`);
}
