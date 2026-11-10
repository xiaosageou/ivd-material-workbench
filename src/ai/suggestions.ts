import { createHash, randomUUID } from 'node:crypto';
import { db, id, transaction } from '../db.ts';
import { getAiConfig } from './config.ts';
import { assertCurrentJobLease, currentReportManifest, appendJobEvent, type Row } from './jobs.ts';
import { readCurrentEvidence } from './knowledge.ts';
import { readCurrentLiteratureEvidence } from '../literature/search.ts';
import { createPreparationDraft, preparationInventoryFingerprint, previewPreparationAllocations, saveRecipeVersion } from '../recipe-service.ts';
import { calculateIngredient, type Ingredient } from '../calculator.ts';
import { isUnit, type Dimension } from '../units.ts';

export type SuggestionType = 'recipe' | 'preparation';
const parseJson = (value: unknown, fallback: any = {}) => { try { return JSON.parse(String(value ?? '')); } catch { return fallback; } };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stripFence = (value: string) => value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
const nonempty = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validTypes = ['ratio','mass_concentration','molar_concentration','stock_dilution','volume_fraction','fixed_addition'];

function validateSelectedSources(request: Row) {
  const selectedReports = request.reportIds ?? request.allowedReportIds;
  const selectedLiterature = request.literatureIds ?? request.allowedLiteratureIds;
  const reportIds = Array.isArray(selectedReports) ? [...new Set(selectedReports.map(String))] : [];
  const literatureIds = Array.isArray(selectedLiterature) ? [...new Set(selectedLiterature.map(String))] : [];
  for (const reportId of reportIds) if (!currentReportManifest(reportId)) throw new Error('所选参考报告已删除或失效');
  if (literatureIds.length) {
    const count = Number((db.prepare(`SELECT COUNT(*) AS n FROM literature_items WHERE deleted_at IS NULL AND id IN (${literatureIds.map(() => '?').join(',')})`)
      .get(...literatureIds) as Row).n);
    if (count !== literatureIds.length) throw new Error('所选参考文献已删除或失效');
  }
}

export function enqueueSuggestionJob(ownerId: string, type: SuggestionType, request: Row) {
  request.reportIds = Array.isArray(request.reportIds) ? [...new Set(request.reportIds.map(String).map(value => value.trim()).filter(Boolean))].slice(0, 20) : [];
  request.literatureIds = Array.isArray(request.literatureIds) ? [...new Set(request.literatureIds.map(String).map(value => value.trim()).filter(Boolean))].slice(0, 100) : [];
  validateSelectedSources(request);
  if (type === 'recipe') {
    if (!nonempty(request.purpose, 2000)) throw new Error('配方用途为必填项且不超过 2,000 字');
    if (request.basedOnRecipeVersionId) {
      const base = db.prepare(`SELECT v.id,r.id AS recipe_id,r.created_by,r.scope,r.active FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id
        WHERE v.id=? AND r.active=1 AND r.scope='team'`).get(String(request.basedOnRecipeVersionId)) as Row | undefined;
      if (!base) throw new Error('基于此版本生成修改建议时需选择组织共享配方');
      if (base.created_by !== ownerId && !(db.prepare('SELECT role FROM users WHERE id=?').get(ownerId) as Row)?.role?.includes('ADMIN')) {
        throw new Error('只有配方创建者或管理员可以基于此配方版本创建修改建议');
      }
    }
  } else {
    const versionId = String(request.recipeVersionId || '');
    const version = db.prepare(`SELECT v.status,r.scope,r.active FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id WHERE v.id=?`).get(versionId) as Row | undefined;
    if (!version || version.status !== 'published' || version.scope !== 'team' || !version.active) throw new Error('配液辅助仅支持当前组织共享的已发布配方版本');
    const preview = previewPreparationAllocations(versionId, request.targetVolume, request.targetVolumeUnit);
    request.targetVolume = preview.targetVolume; request.targetVolumeUnit = preview.targetVolumeUnit;
    request.previewAtRequest = preview;
  }
  const jobId = id('aij_');
  const requestId = randomUUID();
  const fingerprint = hash({ type, ownerId, requestId, request });
  transaction(() => {
    db.prepare(`INSERT INTO ai_jobs(id,job_type,report_id,requested_by,input_fingerprint,input_manifest_json,run_key,status,budget_tokens,timeout_ms)
      VALUES (?,?,?,?,?,?,?,'queued',?,?)`).run(jobId, type === 'recipe' ? 'recipe_suggestion' : 'preparation_suggestion',
      request.reportIds?.[0] || null, ownerId, fingerprint, JSON.stringify({ type, ownerId, request }), `suggestion:${requestId}`,
      getAiConfig().taskTokenBudget, getAiConfig().timeoutMs);
    appendJobEvent(jobId, 'queued', type === 'recipe' ? 'AI 配方建议已排入持久队列' : 'AI 配液建议已排入持久队列', { type });
  });
  return jobId;
}

function validateRefs(raw: unknown, request: Row) {
  const ids = Array.isArray(raw) ? [...new Set(raw.map(String))].slice(0, 100) : [];
  const reportScope = request.reportIds ?? request.allowedReportIds;
  const literatureScope = request.literatureIds ?? request.allowedLiteratureIds;
  const selected = new Set(Array.isArray(reportScope) ? reportScope.map(String) : []);
  const selectedLiterature = new Set(Array.isArray(literatureScope) ? literatureScope.map(String) : []);
  const refs: string[] = [];
  for (const evidenceId of ids) {
    const literature = readCurrentLiteratureEvidence(evidenceId);
    if (literature) {
      if (!selectedLiterature.has(literature.itemId)) throw new Error('建议引用的文献不在用户选择的文献范围内');
      refs.push(evidenceId);
      continue;
    }
    const source = readCurrentEvidence(evidenceId);
    if (!source) throw new Error('建议引用了已删除、已替换或已失效的证据');
    if (!selected.has(source.reportId)) throw new Error('建议引用的报告不在用户选择的报告集合内');
    refs.push(evidenceId);
  }
  return refs;
}

function validateRecipePayload(raw: unknown, request: Row) {
  let value: any;
  try { value = typeof raw === 'string' ? JSON.parse(stripFence(raw)) : raw; } catch { throw new Error('模型没有返回合法的配方建议 JSON'); }
  if (!value || typeof value !== 'object' || !Array.isArray(value.ingredients) || !Array.isArray(value.steps)
    || !Array.isArray(value.assumptions) || !Array.isArray(value.evidenceRefIds)) throw new Error('配方建议结构不符合 schema');
  const missingIngredientIds: number[] = [];
  const ingredients = value.ingredients.slice(0, 100).map((item: any, index: number) => {
    if (!item || !nonempty(item.name, 200) || !validTypes.includes(String(item.calculationType))) throw new Error(`第 ${index + 1} 个组分缺少合法名称或计算方式`);
    const itemDimension = String(item.dimension || '');
    if (!['mass','volume','amount','activity','count'].includes(itemDimension)) throw new Error(`第 ${index + 1} 个组分缺少量纲`);
    const needsAmount = item.calculationType !== 'stock_dilution';
    if (needsAmount && !nonempty(String(item.amountValue ?? ''), 40)) throw new Error(`第 ${index + 1} 个组分缺少参数，需人工补充`);
    if (!nonempty(item.amountUnit, 30)) throw new Error(`第 ${index + 1} 个组分缺少单位`);
    if (item.calculationType === 'stock_dilution' && (!nonempty(String(item.stockConcentration ?? ''), 40)
      || !nonempty(String(item.targetConcentration ?? ''), 40))) throw new Error(`第 ${index + 1} 个母液组分缺少浓度信息`);
    const materialId = String(item.materialId || '').trim();
    if (materialId) {
      const material = db.prepare('SELECT name,dimension,active FROM materials WHERE id=?').get(materialId) as Row | undefined;
      if (!material || !material.active) throw new Error(`第 ${index + 1} 个组分关联了未知或停用物料`);
      if (material.dimension !== itemDimension) throw new Error(`第 ${index + 1} 个组分量纲与物料不一致`);
    } else missingIngredientIds.push(index + 1);
    return { name: String(item.name).trim(), materialId: materialId || '', calculationType: String(item.calculationType),
      amountValue: String(item.amountValue ?? ''), amountUnit: String(item.amountUnit).trim(), dimension: itemDimension,
      stockConcentration: String(item.stockConcentration ?? ''), targetConcentration: String(item.targetConcentration ?? ''),
      molecularWeight: String(item.molecularWeight ?? ''), notes: String(item.notes ?? '').slice(0, 1000),
      rationale: String(item.rationale ?? '').slice(0, 2000) };
  });
  const citedRefs = validateRefs(value.evidenceRefIds, request);
  const missing = [...(Array.isArray(value.missingInfo) ? value.missingInfo.map((item: unknown) => String(item).slice(0, 1000)) : [])]
    .filter(item => !item.startsWith('系统校验：'));
  for (const item of missingIngredientIds) missing.push(`系统校验：为第 ${item} 个组分选择有效的组织物料`);
  if (!nonempty(value.name, 200)) missing.push('系统校验：配方名称');
  if (!nonempty(String(value.baseVolume ?? ''), 40) || !nonempty(value.baseVolumeUnit, 30)) missing.push('系统校验：基准产量和单位');
  if (!nonempty(value.outputName, 200) || !nonempty(value.outputCode, 100) || !nonempty(value.outputUnit, 30)) missing.push('系统校验：产物名称、编号或单位');
  if (!citedRefs.length && !request.basedOnRecipeVersionId) missing.push('系统校验：可引用的来源报告或文献');
  const payload = { name: String(value.name || request.name || '').trim(), purpose: String(request.purpose), baseVolume: String(value.baseVolume || request.baseVolume || ''),
    baseVolumeUnit: String(value.baseVolumeUnit || request.baseVolumeUnit || 'mL'), outputName: String(value.outputName || request.outputName || ''),
    outputCode: String(value.outputCode || request.outputCode || ''), outputUnit: String(value.outputUnit || request.outputUnit || ''),
    outputDimension: String(value.outputDimension || request.outputDimension || 'volume'), steps: value.steps.map((item: unknown) => String(item).slice(0, 1000)).slice(0, 100),
    storage: String(value.storage || '').slice(0, 1000), rationale: String(value.rationale || '').slice(0, 2000), ingredients,
    assumptions: value.assumptions.map((item: unknown) => String(item).slice(0, 1000)).slice(0, 50), missingInfo: [...new Set(missing)], evidenceRefIds: citedRefs,
    basedOnRecipeVersionId: request.basedOnRecipeVersionId || null };
  if (payload.baseVolumeUnit && !isUnit(payload.baseVolumeUnit, 'volume')) missing.push(`系统校验：基准产量单位“${payload.baseVolumeUnit}”未配置或不是体积单位`);
  if (payload.outputDimension && ['mass','volume','amount','activity','count'].includes(payload.outputDimension)
    && payload.outputUnit && !isUnit(payload.outputUnit, payload.outputDimension as Dimension)) {
    missing.push(`系统校验：产物单位“${payload.outputUnit}”未配置或与产物量纲不匹配`);
  }
  if (isUnit(payload.baseVolumeUnit, 'volume') && nonempty(payload.baseVolume, 40)) {
    for (const [index, ingredient] of ingredients.entries()) {
      const material = ingredient.materialId ? db.prepare('SELECT base_unit,dimension FROM materials WHERE id=? AND active=1').get(ingredient.materialId) as Row | undefined : undefined;
      try {
        calculateIngredient({ name: ingredient.name, calculation_type: ingredient.calculationType,
          amount_value: ingredient.calculationType === 'stock_dilution' ? ingredient.targetConcentration : ingredient.amountValue,
          amount_unit: ingredient.amountUnit, stock_concentration: ingredient.stockConcentration, target_concentration: ingredient.targetConcentration,
          molecular_weight: ingredient.molecularWeight, dimension: ingredient.dimension, material_unit: material?.base_unit,
          material_dimension: material?.dimension } as Ingredient, payload.baseVolume, payload.baseVolume, payload.baseVolumeUnit, payload.baseVolumeUnit);
      } catch (error) { missing.push(`系统校验：第 ${index + 1} 个组分参数校验：${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  payload.missingInfo = [...new Set(missing)];
  let baseVersionCount = 0;
  if (request.basedOnRecipeVersionId) {
    const base = db.prepare('SELECT recipe_id FROM recipe_versions WHERE id=?').get(String(request.basedOnRecipeVersionId)) as Row | undefined;
    if (!base) missing.push('基于的配方版本已删除');
    else baseVersionCount = Number((db.prepare('SELECT COALESCE(MAX(version),0) AS n FROM recipe_versions WHERE recipe_id=?').get(base.recipe_id) as Row).n);
  }
  payload.missingInfo = [...new Set(missing)];
  const expectedVersion = hash({ baseRecipeVersionId: request.basedOnRecipeVersionId || null, baseVersionCount, payload });
  return { payload, citedRefs, status: missing.length ? 'needs_input' : 'ready', expectedVersion, baseVersionCount };
}

function validatePreparationPayload(raw: unknown, request: Row) {
  let value: any;
  try { value = typeof raw === 'string' ? JSON.parse(stripFence(raw)) : raw; } catch { throw new Error('模型没有返回合法的配液建议 JSON'); }
  if (!value || typeof value !== 'object' || !Array.isArray(value.assumptions) || !Array.isArray(value.cautions) || !Array.isArray(value.evidenceRefIds)) {
    throw new Error('配液建议结构不符合 schema');
  }
  const citedRefs = validateRefs(value.evidenceRefIds, request);
  const preview = previewPreparationAllocations(String(request.recipeVersionId), request.targetVolume, request.targetVolumeUnit);
  const missing = [...(Array.isArray(value.missingInfo) ? value.missingInfo.map((item: unknown) => String(item).slice(0, 1000)) : [])];
  for (const ingredient of preview.allocations) if (ingredient.missingReason) missing.push(`${ingredient.name}：${ingredient.missingReason}`);
  const payload = { recipeVersionId: String(request.recipeVersionId), targetVolume: preview.targetVolume, targetVolumeUnit: preview.targetVolumeUnit,
    preview, rationale: String(value.rationale || '').slice(0, 3000), assumptions: value.assumptions.map((item: unknown) => String(item).slice(0, 1000)).slice(0, 50),
    cautions: value.cautions.map((item: unknown) => String(item).slice(0, 1000)).slice(0, 50), missingInfo: [...new Set(missing)], evidenceRefIds: citedRefs };
  const expectedVersion = hash({ recipeVersionId: preview.recipeVersionId, targetVolume: preview.targetVolume, targetVolumeUnit: preview.targetVolumeUnit,
    inventoryFingerprint: preview.inventoryFingerprint, evidenceRefIds: citedRefs });
  return { payload, citedRefs, status: missing.length ? 'needs_input' : 'ready', expectedVersion };
}

export function completeSuggestionJob(job: Row, type: SuggestionType, raw: string, request: Row) {
  const result: any = type === 'recipe' ? validateRecipePayload(raw, request) : validatePreparationPayload(raw, request);
  let suggestionId = id('ais_');
  let alreadySaved = false;
  const baseRecipeVersionId = type === 'preparation'
    ? String(result.payload.recipeVersionId)
    : String(result.payload.basedOnRecipeVersionId || '');
  const expectedBaseVersionCount = type === 'recipe' ? result.baseVersionCount : null;
  transaction(() => {
    assertCurrentJobLease(job);
    const currentJob = db.prepare('SELECT status,cancel_requested FROM ai_jobs WHERE id=?').get(job.id) as Row | undefined;
    if (!currentJob || currentJob.cancel_requested || currentJob.status === 'cancelled') throw new Error('建议任务已取消，模型结果未保存');
    if (currentJob.status === 'completed') {
      const existing = db.prepare('SELECT id FROM ai_suggestions WHERE job_id=?').get(job.id) as Row | undefined;
      if (!existing) throw new Error('建议任务已完成但结果记录不存在');
      suggestionId = String(existing.id); alreadySaved = true;
      return;
    }
    validateSelectedSources(request);
    validateRefs(result.citedRefs, request);
    db.prepare(`INSERT INTO ai_suggestions(id,suggestion_type,report_id,recipe_version_id,owner_id,job_id,status,payload_json,validation_json,cited_refs_json,expected_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(suggestionId, type, job.report_id || null, baseRecipeVersionId || null, job.requested_by,
      job.id, result.status, JSON.stringify(result.payload), JSON.stringify({ missingInfo: result.payload.missingInfo, ready: result.status === 'ready',
        allowedReportIds: request.reportIds || [], allowedLiteratureIds: request.literatureIds || [], expectedBaseVersionCount }),
      JSON.stringify(result.citedRefs), result.expectedVersion);
    const progress = JSON.stringify({ stage: 'completed', suggestionId, suggestionStatus: result.status });
    const update = job.lease_owner
      ? db.prepare(`UPDATE ai_jobs SET status='completed',finished_at=datetime('now'),updated_at=datetime('now'),lease_owner=NULL,lease_until_ms=NULL,
          provider=?,model=?,progress_json=?,error_code=NULL,error_message=NULL WHERE id=? AND lease_owner=? AND attempt_count=? AND lease_until_ms>? AND cancel_requested=0`)
        .run(process.env.IVD_AI_PROVIDER || null, process.env.IVD_AI_MODEL || null, progress, job.id, job.lease_owner, job.attempt_count, Date.now())
      : db.prepare(`UPDATE ai_jobs SET status='completed',finished_at=datetime('now'),updated_at=datetime('now'),lease_owner=NULL,lease_until_ms=NULL,
          provider=?,model=?,progress_json=?,error_code=NULL,error_message=NULL WHERE id=?`)
        .run(process.env.IVD_AI_PROVIDER || null, process.env.IVD_AI_MODEL || null, progress, job.id);
    if (!update.changes) throw new Error('AI 任务租约已失效，拒绝保存旧建议');
  });
  if (!alreadySaved) appendJobEvent(String(job.id), 'suggestion.completed', 'AI 建议已生成并保存为待审核草稿', { suggestionId, status: result.status });
  return suggestionId;
}

export function getSuggestionForUser(suggestionId: string, userId: string, role: string) {
  const row = db.prepare(`SELECT s.*,j.status AS job_status,j.error_message,j.provider,j.model FROM ai_suggestions s LEFT JOIN ai_jobs j ON j.id=s.job_id WHERE s.id=?`)
    .get(suggestionId) as Row | undefined;
  if (!row || (row.owner_id !== userId && role !== 'ADMIN')) return undefined;
  const payload = parseJson(row.payload_json);
  const citations = (parseJson(row.cited_refs_json, []) as string[]).flatMap(evidenceRefId => {
    const literature = readCurrentLiteratureEvidence(evidenceRefId);
    if (literature) return [{ evidenceRefId, sourceType: 'literature', source: literature, literatureId: literature.itemId, valid: true }];
    const source = readCurrentEvidence(evidenceRefId);
    return source ? [{ evidenceRefId, sourceType: 'report', source, reportId: source.reportId, valid: true }]
      : [{ evidenceRefId, sourceType: 'unknown', valid: false }];
  });
  return { id: row.id, type: row.suggestion_type, status: row.status, ownerId: row.owner_id, jobId: row.job_id,
    expectedVersion: row.expected_version, payload, validation: parseJson(row.validation_json), citations,
    createdAt: row.created_at, updatedAt: row.updated_at, jobStatus: row.job_status, errorMessage: row.error_message,
    provider: row.provider, model: row.model };
}

export function editSuggestion(suggestionId: string, ownerId: string, role: string, input: Row) {
  const row = db.prepare('SELECT * FROM ai_suggestions WHERE id=?').get(suggestionId) as Row | undefined;
  if (!row || (row.owner_id !== ownerId && role !== 'ADMIN')) throw new Error('建议不存在');
  if (row.status === 'confirmed' || row.status === 'cancelled') throw new Error('已确认或取消的建议不能修改');
  const oldPayload = parseJson(row.payload_json);
  const nextPayload = { ...oldPayload, ...input };
  let result: any;
  if (row.suggestion_type === 'preparation') {
    const preview = previewPreparationAllocations(String(nextPayload.recipeVersionId), nextPayload.targetVolume, nextPayload.targetVolumeUnit);
    const missingInfo = preview.allocations.filter((item: Row) => item.missingReason).map((item: Row) => `${item.name}：${item.missingReason}`);
    const validation = parseJson(row.validation_json);
    const citedRefs = validateRefs(nextPayload.evidenceRefIds ?? parseJson(row.cited_refs_json, []), validation);
    result = { payload: { ...nextPayload, targetVolume: preview.targetVolume, targetVolumeUnit: preview.targetVolumeUnit, preview, missingInfo,
        evidenceRefIds: citedRefs },
      citedRefs, status: missingInfo.length ? 'needs_input' : 'ready',
      expectedVersion: hash({ recipeVersionId: preview.recipeVersionId, targetVolume: preview.targetVolume, targetVolumeUnit: preview.targetVolumeUnit,
        inventoryFingerprint: preview.inventoryFingerprint, evidenceRefIds: citedRefs }) };
  } else {
    result = validateRecipePayload(nextPayload, { reportIds: parseJson(row.validation_json).allowedReportIds || [],
      literatureIds: parseJson(row.validation_json).allowedLiteratureIds || [],
      basedOnRecipeVersionId: oldPayload.basedOnRecipeVersionId });
  }
  db.prepare(`UPDATE ai_suggestions SET payload_json=?,validation_json=?,cited_refs_json=?,expected_version=?,status=?,updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(result.payload), JSON.stringify({ missingInfo: result.payload.missingInfo, ready: result.status === 'ready',
      allowedReportIds: parseJson(row.validation_json).allowedReportIds || [], allowedLiteratureIds: parseJson(row.validation_json).allowedLiteratureIds || [],
      expectedBaseVersionCount: result.baseVersionCount ?? null }),
      JSON.stringify(result.citedRefs), result.expectedVersion, result.status, suggestionId);
  return getSuggestionForUser(suggestionId, ownerId, role);
}

export function confirmSuggestion(suggestionId: string, actorId: string, role: string, idempotencyKey: unknown, expectedVersion: unknown) {
  const suggestion = db.prepare('SELECT * FROM ai_suggestions WHERE id=?').get(suggestionId) as Row | undefined;
  if (!suggestion || (suggestion.owner_id !== actorId && role !== 'ADMIN')) throw new Error('建议不存在');
  const prior = db.prepare('SELECT * FROM ai_confirmations WHERE suggestion_id=?').get(suggestionId) as Row | undefined;
  if (prior) return { alreadyConfirmed: true, resultType: prior.result_type, resultId: prior.result_id };
  const key = String(idempotencyKey || '').trim();
  if (!key || key.length > 120) throw new Error('确认操作需要有效的幂等编号');
  if (String(expectedVersion || '') !== String(suggestion.expected_version)) throw new Error('建议内容已更新，请重新读取并确认当前版本');
  if (suggestion.status !== 'ready') throw new Error('建议仍有待补信息或未通过校验，请先编辑完善');
  const payload = parseJson(suggestion.payload_json);
  const refs = parseJson(suggestion.cited_refs_json, []) as string[];
  const validation = parseJson(suggestion.validation_json);
  validateSelectedSources(validation);
  validateRefs(refs, validation);
  const reusedKey = db.prepare('SELECT suggestion_id,result_type,result_id FROM ai_confirmations WHERE idempotency_key=?').get(key) as Row | undefined;
  if (reusedKey) {
    if (reusedKey.suggestion_id !== suggestionId) throw new Error('此幂等编号已用于其他确认操作');
    return { alreadyConfirmed: true, resultType: reusedKey.result_type, resultId: reusedKey.result_id };
  }
  let resultType = '';
  let resultId = '';
  let alreadyConfirmed = false;
  transaction(() => {
    const already = db.prepare('SELECT result_type,result_id FROM ai_confirmations WHERE suggestion_id=?').get(suggestionId) as Row | undefined;
    if (already) {
      resultType = String(already.result_type); resultId = String(already.result_id);
      alreadyConfirmed = true;
      return;
    }
    const reused = db.prepare('SELECT suggestion_id,result_type,result_id FROM ai_confirmations WHERE idempotency_key=?').get(key) as Row | undefined;
    if (reused) {
      if (reused.suggestion_id !== suggestionId) throw new Error('此幂等编号已用于其他确认操作');
      resultType = String(reused.result_type); resultId = String(reused.result_id);
      alreadyConfirmed = true;
      return;
    }
    const currentSuggestion = db.prepare('SELECT status,expected_version FROM ai_suggestions WHERE id=?').get(suggestionId) as Row | undefined;
    if (!currentSuggestion || currentSuggestion.status !== 'ready') throw new Error('建议状态已变化，请重新读取后确认');
    if (String(currentSuggestion.expected_version) !== String(expectedVersion || '')) throw new Error('建议内容已更新，请重新读取并确认当前版本');
    validateSelectedSources(validation);
    validateRefs(refs, validation);
    if (suggestion.suggestion_type === 'preparation') {
      const version = db.prepare(`SELECT v.status,r.active,r.scope FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id WHERE v.id=?`)
        .get(payload.recipeVersionId) as Row | undefined;
      if (!version || version.status !== 'published' || !version.active || version.scope !== 'team') throw new Error('配方版本已停用或不再发布，需重新生成配液建议');
      if (preparationInventoryFingerprint(payload.recipeVersionId) !== payload.preview.inventoryFingerprint) throw new Error('原料批次或库存状态已变化，请重新预览配液建议');
      const currentPreview = previewPreparationAllocations(payload.recipeVersionId, payload.targetVolume, payload.targetVolumeUnit);
      if (currentPreview.allocations.some(item => item.missingReason)) throw new Error('当前没有满足配液条件的原料批次，请补充库存或调整目标量');
      resultId = createPreparationDraft(payload.recipeVersionId, payload.targetVolume, payload.targetVolumeUnit, actorId);
      resultType = 'preparation';
      db.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)`)
        .run(id('aud_'), actorId, 'ai.preparation_suggestion.confirm', 'preparation', resultId,
          JSON.stringify({ suggestionId, recipeVersionId: payload.recipeVersionId, citedSources: refs.map(refId => {
            const source = readCurrentLiteratureEvidence(refId);
            return source ? { type: 'literature', id: source.itemId, evidenceRefId: refId, versionId: source.versionId, contentSha256: source.contentSha256 }
              : (() => { const report = readCurrentEvidence(refId); return { type: 'report', evidenceRefId: refId,
                reportId: report?.reportId || '', sourceVersionId: report?.sourceVersionId || '', contentSha256: report?.contentSha256 || '' }; })();
          }) }));
    } else {
      let recipeId = '';
      let nextVersion = 1;
      if (payload.basedOnRecipeVersionId) {
        const base = db.prepare(`SELECT v.recipe_id,v.version,r.created_by,r.active,r.scope FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id
          WHERE v.id=?`).get(payload.basedOnRecipeVersionId) as Row | undefined;
        if (!base || !base.active || base.scope !== 'team') throw new Error('基于的配方已停用或不存在');
        if (base.created_by !== actorId && role !== 'ADMIN') throw new Error('只有配方创建者或管理员可保存此修改建议');
        recipeId = String(base.recipe_id);
        const current = Number((db.prepare('SELECT COALESCE(MAX(version),0) AS n FROM recipe_versions WHERE recipe_id=?').get(recipeId) as Row).n);
        const expectedCount = parseJson(suggestion.validation_json).expectedBaseVersionCount;
        if (expectedCount !== null && expectedCount !== undefined && current !== Number(expectedCount)) throw new Error('基于的配方版本已新增后续版本，请重新生成建议');
        nextVersion = current + 1;
      } else {
        recipeId = id('rcp_');
        db.prepare(`INSERT INTO recipes(id,name,scope,owner_id,source_type,created_by) VALUES (?,?,'team',?,'ai_draft',?)`)
          .run(recipeId, String(payload.name), actorId, actorId);
      }
      const recipeInput = { ...payload, sourceNote: `AI 建议稿；用户 ${actorId} 确认创建`, rationale: payload.rationale };
      resultId = saveRecipeVersion(recipeId, recipeInput, actorId, nextVersion);
      resultType = 'recipe_version';
      db.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)`)
        .run(id('aud_'), actorId, 'ai.recipe_suggestion.confirm', 'recipe_version', resultId,
          JSON.stringify({ suggestionId, recipeId, citedSources: refs.map(refId => {
            const source = readCurrentLiteratureEvidence(refId);
            return source ? { type: 'literature', id: source.itemId, evidenceRefId: refId, versionId: source.versionId, contentSha256: source.contentSha256 }
              : (() => { const report = readCurrentEvidence(refId); return { type: 'report', evidenceRefId: refId,
                reportId: report?.reportId || '', sourceVersionId: report?.sourceVersionId || '', contentSha256: report?.contentSha256 || '' }; })();
          }) }));
    }
    db.prepare(`INSERT INTO ai_confirmations(idempotency_key,suggestion_id,actor_id,result_type,result_id) VALUES (?,?,?,?,?)`)
      .run(key, suggestionId, actorId, resultType, resultId);
    db.prepare(`UPDATE ai_suggestions SET status='confirmed',confirmed_by=?,confirmed_at=datetime('now'),result_type=?,result_id=?,updated_at=datetime('now') WHERE id=?`)
      .run(actorId, resultType, resultId, suggestionId);
  });
  return { alreadyConfirmed, resultType, resultId };
}
