import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { db } from '../db.ts';
import { calculateIngredient, calculateRecipe, type Ingredient } from '../calculator.ts';
import { searchKnowledge, readCurrentEvidence, getReportManifestSummary, calculateDatasetSummary, resolveObservationValue } from './knowledge.ts';
import { previewPreparationAllocations } from '../recipe-service.ts';
import { isLiteratureInScope, readCurrentLiteratureEvidence, searchLiterature, type LiteratureScope } from '../literature/search.ts';
import { semanticSearchReportKnowledge } from '../report-knowledge.ts';

export type ToolContext = { jobId: string; contextType: 'knowledge_base' | 'report' | 'reports' | 'recipe'; contextIds: string[];
  literatureScope?: LiteratureScope; reportScope?: string[]; actor?: { id: string; role: string } };
const object = (properties: Record<string, any>) => Type.Object(properties, { additionalProperties: false });
const payload = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });

function tool(name: string, label: string, description: string, parameters: any, execute: (args: any) => unknown | Promise<unknown>): AgentTool<any> {
  return { name, label, description, parameters, executionMode: 'sequential',
    execute: async (_id, args) => payload(await execute(args)) };
}

function permittedReportIds(context: ToolContext, requested?: string[]) {
  const allowed = context.reportScope !== undefined ? context.reportScope : context.contextType === 'report' || context.contextType === 'reports' ? context.contextIds
    : context.contextType === 'recipe' ? [] : undefined;
  if (requested?.length && allowed && requested.some(id => !allowed.includes(id))) throw new Error('本会话上下文未选择请求的报告');
  return requested?.length ? requested : allowed;
}

type ComparisonRecord = { fieldKey: string; value: unknown };
const genericComparisonFields = new Set(['result', 'results', 'value', 'observation', 'observations', 'data']);
const comparisonMetricKeys = ['metric', 'indicator', 'analyte', 'target', 'measurement', 'parameter'];
const unknownLabels = new Set(['unknown','unspecified','not reported','not stated','not available','n/a','na','?','-','—','未知','不详','未说明','未报告','缺失']);
const meaningfulLabel = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && !unknownLabels.has(value.trim().toLocaleLowerCase());
const stableJson = (value: any): string => Array.isArray(value) ? `[${value.map(stableJson).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function strictFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (!clean || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(clean)) return undefined;
  const result = Number(clean);
  return Number.isFinite(result) ? result : undefined;
}

function comparisonMetric(record: ComparisonRecord): string | undefined {
  const value = record.value && typeof record.value === 'object' && !Array.isArray(record.value) ? record.value as Record<string, unknown> : {};
  for (const key of comparisonMetricKeys) {
    const metric = value[key];
    if (meaningfulLabel(metric)) return metric.trim().toLocaleLowerCase();
  }
  const field = record.fieldKey.trim().toLocaleLowerCase();
  return field && !genericComparisonFields.has(field) ? field : undefined;
}

function completeConditionValue(value: unknown): boolean {
  if (typeof value === 'string') return meaningfulLabel(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(completeConditionValue);
  if (value && typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>);
    return values.length > 0 && values.every(completeConditionValue);
  }
  return false;
}

function comparisonConditions(value: unknown): { signature?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const conditions = record.comparison_context ?? record.experimental_conditions ?? record.conditions ?? record.condition;
  if (!completeConditionValue(conditions)) return {};
  return { signature: stableJson(conditions) };
}

export function assessObservationComparison(records: ComparisonRecord[]) {
  const issues = new Set<string>();
  if (records.length < 2) issues.add('至少需要两条观察');
  const fields = new Set(records.map(item => item.fieldKey.trim()).filter(Boolean));
  if (fields.size !== 1 || records.some(item => !item.fieldKey.trim())) issues.add('比较字段不同或缺失');

  const metrics = records.map(comparisonMetric);
  if (metrics.some(metric => !metric)) issues.add('缺少明确指标身份');
  else if (new Set(metrics).size !== 1) issues.add('指标不同');

  const values = records.map(item => item.value && typeof item.value === 'object' && !Array.isArray(item.value)
    ? (item.value as Record<string, unknown>).value : item.value);
  const numbers = values.map(strictFiniteNumber);
  if (numbers.some(value => value === undefined)) issues.add('至少一项不是严格有限数值');

  const units = records.map(item => item.value && typeof item.value === 'object' && !Array.isArray(item.value)
    ? (item.value as Record<string, unknown>).unit : undefined);
  const cleanUnits = units.map(unit => meaningfulLabel(unit) ? unit.trim() : '');
  if (cleanUnits.some(unit => !unit)) issues.add('至少一项缺少显式单位（无量纲请明确填写 1 或 dimensionless）');
  else if (new Set(cleanUnits).size !== 1) issues.add('单位不同');

  const conditions = records.map(item => comparisonConditions(item.value));
  if (conditions.some(item => !item.signature)) issues.add('缺少可核对的实验条件信息');
  else if (new Set(conditions.map(item => item.signature)).size !== 1) issues.add('实验条件不同');

  const comparable = issues.size === 0;
  const unit = cleanUnits.length && cleanUnits.every(value => value && value === cleanUnits[0]) ? cleanUnits[0] : null;
  return { comparable,
    reason: comparable ? '比较字段、指标、显式单位和实验条件一致；数值差仅作描述，不表示因果。'
      : `${[...issues].join('；')}；仅并列展示，不计算数值差。`,
    issues: [...issues], rows: records,
    numericDifference: comparable ? numbers.slice(1).map(value => {
      const difference = value! - numbers[0]!;
      return difference === 0 ? 0 : Number(difference.toPrecision(12));
    }) : undefined,
    unit };
}

function recipeVersion(versionId: string) {
  return db.prepare(`SELECT v.*,r.name AS recipe_name,r.scope,r.created_by AS recipe_created_by FROM recipe_versions v
    JOIN recipes r ON r.id=v.recipe_id WHERE v.id=? AND r.active=1 AND r.scope='team'`).get(versionId) as Record<string, any> | undefined;
}

function assertRecipeContext(context: ToolContext, versionId: string) {
  if (context.contextType === 'recipe' && context.contextIds[0] !== versionId) throw new Error('配方版本不在本会话上下文内');
}

function ingredientsFor(versionId: string) {
  return db.prepare(`SELECT i.*,m.base_unit AS material_unit,m.dimension AS material_dimension,m.name AS linked_material_name FROM recipe_ingredients i
  LEFT JOIN materials m ON m.id=i.material_id WHERE i.recipe_version_id=?`).all(versionId) as Array<Ingredient & Record<string, any>>;
}

function toolResultForRecipe(versionId: string, targetVolume: string, targetVolumeUnit: string) {
  const version = recipeVersion(versionId);
  if (!version) throw new Error('组织共享配方版本不存在');
  if (version.status !== 'published') throw new Error('只对已发布配方版本提供辅助计算');
  const ingredients = ingredientsFor(versionId);
  const lines = calculateRecipe(ingredients, targetVolume, version.base_volume, targetVolumeUnit || version.base_volume_unit, version.base_volume_unit)
    .map((line, index) => ({ ...line, ingredientId: ingredients[index].id, materialId: ingredients[index].material_id,
      expectedUnit: ingredients[index].material_unit || line.unit }));
  return { recipeName: version.recipe_name, recipeVersionId: versionId, version: version.version, status: version.status,
    baseVolume: version.base_volume, baseVolumeUnit: version.base_volume_unit, targetVolume, targetVolumeUnit: targetVolumeUnit || version.base_volume_unit,
    lines, deterministicCalculation: true, notes: ['结果由系统计算；模型生成的数字不会覆盖该结果。', 'pH 调整用量需现场记录，不预测滴定量。'] };
}

function availableLots(materialId: string) {
  return db.prepare(`SELECT l.id,l.internal_lot,l.manufacturer_lot,l.status,l.expiry_date,l.concentration,l.concentration_unit,m.name AS material_name,
      m.base_unit,m.dimension,b.location_id,loc.name AS location_name,b.quantity
    FROM inventory_lots l JOIN materials m ON m.id=l.material_id JOIN stock_balances b ON b.lot_id=l.id JOIN locations loc ON loc.id=b.location_id
    WHERE l.material_id=? AND CAST(b.quantity AS REAL)>0 ORDER BY CASE l.status WHEN 'active' THEN 0 ELSE 1 END,l.expiry_date,l.internal_lot`)
    .all(materialId) as Record<string, any>[];
}

function previewLots(versionId: string, targetVolume: string, targetVolumeUnit: string) {
  const base = toolResultForRecipe(versionId, targetVolume, targetVolumeUnit);
  const ingredients = ingredientsFor(versionId);
  const byIngredient = ingredients.map((ingredient, index) => {
    const lots = ingredient.material_id ? availableLots(String(ingredient.material_id)) : [];
    const candidates = lots.map(lot => {
      let amount: string | null = base.lines[index].quantity;
      let unit = String(base.lines[index].expectedUnit);
      let calculationError: string | undefined;
      if (ingredient.calculation_type === 'stock_dilution') {
        try {
          if (!lot.concentration || !lot.concentration_unit) throw new Error('批次缺少浓度或浓度单位');
          const calculated = calculateIngredient(ingredient, targetVolume, String((recipeVersion(versionId)!).base_volume), targetVolumeUnit || String((recipeVersion(versionId)!).base_volume_unit),
            String((recipeVersion(versionId)!).base_volume_unit), { value: String(lot.concentration), unit: String(lot.concentration_unit) });
          amount = calculated.quantity; unit = calculated.unit;
        } catch (error) { amount = null; calculationError = error instanceof Error ? error.message : String(error); }
      }
      return { lotId: lot.id, internalLot: lot.internal_lot, status: lot.status, expiryDate: lot.expiry_date || null,
        concentration: lot.concentration || null, concentrationUnit: lot.concentration_unit || null, locationId: lot.location_id,
        locationName: lot.location_name, availableQuantity: lot.quantity, stockUnit: lot.base_unit, requiredQuantity: amount, requiredUnit: unit,
        calculationError, advisoryOnly: true };
    });
    return { ingredientId: ingredient.id, name: ingredient.name, materialId: ingredient.material_id || null,
      materialName: ingredient.linked_material_name || ingredient.name, theoretical: base.lines[index], batches: candidates };
  });
  return { ...base, allocations: byIngredient, inventoryChanged: false,
    note: '配液批次和数量由当前库存与批次参数计算；此预览不锁定、不扣减库存。创建正式任务时服务端会再次读取当前状态。' };
}

export function buildAssistantTools(context: ToolContext, onToolResult?: (toolName: string, result: unknown) => void): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    tool('search_literature', '检索已选文献', '仅在本会话明确选择的文献/集合范围内检索；返回当前版本片段、页码和可验证证据 ID。不会自动扩展到全库。',
      object({ query: Type.String({ minLength: 1, maxLength: 1000 }), mode: Type.Optional(Type.Union([Type.Literal('keyword'),Type.Literal('semantic'),Type.Literal('hybrid')])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), async args => {
        if (!context.literatureScope) return { results: [], fallbackReason: '本会话没有显式选择文献范围。' };
        const result = await searchLiterature(args.query, { mode: 'semantic', limit: args.limit || 8, actor: context.actor,
          scope: context.literatureScope, persistEvidence: true });
        return { mode: result.mode, fallbackReason: result.fallbackReason, usage: result.usage,
          results: result.results.map(item => ({ evidenceRefId: item.evidenceRefId, literatureId: item.literatureId || item.itemId || item.id,
            itemId: item.itemId || item.item_id || item.id, chunkId: item.chunkId, title: item.title,
            authors: item.authors || JSON.parse(String(item.authors_json || '[]')), year: item.publication_year, doi: item.doi,
            sourceExtent: item.sourceExtent, locator: item.locator, excerpt: item.excerpt, retrieval: item.retrieval })) };
      }),
    tool('read_literature_evidence', '读取文献证据片段', '按文献检索返回的 evidenceRefId 读取仍有效的当前全文或摘要片段；已删除、已替换或超出当前会话范围的证据不可读。',
      object({ evidenceRefId: Type.String({ minLength: 1, maxLength: 120 }) }), args => {
        if (!context.literatureScope) throw new Error('本会话没有显式选择文献范围');
        const evidence = readCurrentLiteratureEvidence(String(args.evidenceRefId));
        if (!evidence || !isLiteratureInScope(context.literatureScope, evidence.itemId)) throw new Error('文献证据已失效或不在本会话上下文内');
        return evidence;
      }),
    tool('get_literature_metadata', '读取文献书目信息', '读取当前有效文献的书目、摘要和版本；文献必须在本会话明确选择的范围内。',
      object({ literatureId: Type.String({ minLength: 1, maxLength: 120 }) }), args => {
        if (!context.literatureScope || !isLiteratureInScope(context.literatureScope, String(args.literatureId))) throw new Error('文献不在本会话上下文内');
        const item = db.prepare(`SELECT i.id,i.title,i.authors_json,i.publication_year,i.journal,i.doi,i.pmid,i.abstract,i.keywords_json,i.current_version_id,
            v.original_name,v.extension,v.size_bytes,v.sha256 FROM literature_items i LEFT JOIN literature_file_versions v ON v.id=i.current_version_id
          WHERE i.id=? AND i.deleted_at IS NULL`).get(String(args.literatureId)) as Record<string, any> | undefined;
        if (!item) throw new Error('文献已删除或不存在');
        return { ...item, authors: JSON.parse(String(item.authors_json || '[]')), keywords: JSON.parse(String(item.keywords_json || '[]')) };
      }),
    tool('search_reports', '搜索研发报告', '在组织内当前有效的报告中按关键词检索，返回报告 ID 与元数据。历史资料需显式选择。',
      object({ q: Type.String({ maxLength: 200 }), includeHistory: Type.Optional(Type.Boolean()) }), async args => {
        const allowed = permittedReportIds(context);
        if (allowed && !allowed.length) return [];
        const data = args.includeHistory ? searchKnowledge({ q: args.q, reportIds: allowed, includeHistory: true, limit: 30 })
          : await semanticSearchReportKnowledge(args.q, allowed, 30, context.actor?.id || '');
        return data.reports;
      }),
    tool('read_evidence', '读取证据原文', '按检索结果给出的 evidenceRefId 读取仍然有效的来源片段和稳定定位。已删除或已替换的来源不可读取。',
      object({ evidenceRefId: Type.String({ minLength: 1, maxLength: 120 }) }), args => {
        const evidence = readCurrentEvidence(args.evidenceRefId);
        if (!evidence) throw new Error('证据来源已删除、已替换或不在当前活动版本中');
        if (context.contextType === 'recipe' && context.reportScope === undefined) throw new Error('配方版本会话不包含报告证据上下文');
        const allowedReports = permittedReportIds(context);
        if (allowedReports && !allowedReports.includes(evidence.reportId)) {
          throw new Error('证据报告不在本会话上下文内');
        }
        return evidence;
      }),
    tool('search_observations', '搜索结构化知识', '检索当前有效报告中的机器整理与人工复核条目；结果附带可回查证据。',
      object({ q: Type.String({ maxLength: 200 }), fieldKey: Type.Optional(Type.String({ maxLength: 80 })), reviewState: Type.Optional(Type.String({ maxLength: 40 })) }), async args => {
        const allowed = permittedReportIds(context);
        if (allowed?.length === 0) return [];
        const result = await semanticSearchReportKnowledge(args.q, allowed, 40, context.actor?.id || '');
        return result.observations.filter(item => (!args.fieldKey || String(item.fieldKey).toLocaleLowerCase().includes(String(args.fieldKey).toLocaleLowerCase()))
          && (!args.reviewState || String(item.reviewState) === args.reviewState));
      }),
    tool('get_report_manifest', '获取报告来源清单', '读取活动报告正文及原始数据附件的版本、文件名、格式、大小和 SHA-256。',
      object({ reportId: Type.String({ minLength: 1, maxLength: 120 }) }), args => {
        const allowed = permittedReportIds(context);
        if (allowed && !allowed.includes(args.reportId)) throw new Error('报告不在本会话上下文内');
        const manifest = getReportManifestSummary(args.reportId);
        if (!manifest) throw new Error('报告已删除或不存在');
        return manifest;
      }),
    tool('get_recipe_version', '读取组织配方版本', '读取组织共享配方的版本、组分、单位、计算类型和步骤；不写入任何业务数据。',
      object({ recipeVersionId: Type.String({ minLength: 1, maxLength: 120 }) }), args => {
        assertRecipeContext(context, String(args.recipeVersionId));
        const version = recipeVersion(args.recipeVersionId);
        if (!version) throw new Error('组织共享配方版本不存在');
        return { id: version.id, recipeName: version.recipe_name, version: version.version, status: version.status,
          baseVolume: version.base_volume, baseVolumeUnit: version.base_volume_unit, outputName: version.output_name,
          outputUnit: version.output_unit, ingredients: ingredientsFor(String(version.id)), steps: JSON.parse(String(version.steps_json || '[]')) };
      }),
    tool('find_material_lots', '查找原料批次', '按物料、批号或制造批号检索当前余额；状态和有效期仍需在创建任务时重新核验。',
      object({ q: Type.String({ minLength: 1, maxLength: 160 }) }), args => {
        let sql = `SELECT l.id,m.name AS material_name,m.code,l.internal_lot,l.manufacturer_lot,l.status,l.expiry_date,
          l.concentration,l.concentration_unit,m.base_unit,b.quantity,loc.name AS location_name
        FROM inventory_lots l JOIN materials m ON m.id=l.material_id JOIN stock_balances b ON b.lot_id=l.id JOIN locations loc ON loc.id=b.location_id
        WHERE CAST(b.quantity AS REAL)>0 AND (m.name LIKE ? OR m.code LIKE ? OR l.internal_lot LIKE ? OR l.manufacturer_lot LIKE ?)
        `;
        const params: any[] = [`%${args.q}%`,`%${args.q}%`,`%${args.q}%`,`%${args.q}%`];
        if (context.contextType === 'recipe') {
          const versionId = String(context.contextIds[0] || '');
          if (!versionId) throw new Error('配方会话缺少配方版本上下文');
          sql += ' AND l.material_id IN (SELECT material_id FROM recipe_ingredients WHERE recipe_version_id=?)';
          params.push(versionId);
        }
        sql += ' ORDER BY m.name,l.expiry_date LIMIT 100';
        return db.prepare(sql).all(...params);
      }),
    tool('calculate_dataset_summary', '计算原始数据摘要', '对已解析、仍活动的报告数据列计算数值数量、缺失数、均值、样本标准差和 CV；分组列可选。',
      object({ datasetId: Type.String({ minLength: 1, maxLength: 120 }), columnKey: Type.String({ minLength: 1, maxLength: 50 }), groupBy: Type.Optional(Type.String({ maxLength: 50 })) }),
      args => {
        const dataset = db.prepare('SELECT e.report_id FROM document_datasets d JOIN document_extractions e ON e.id=d.extraction_id WHERE d.id=?')
          .get(args.datasetId) as Record<string, any> | undefined;
        if (!dataset) throw new Error('所选数据集不存在');
        const allowedReports = permittedReportIds(context);
        if (allowedReports && !allowedReports.includes(String(dataset.report_id))) throw new Error('数据集报告不在本会话上下文内');
        if (context.contextType === 'recipe') throw new Error('配方版本会话不包含原始数据集上下文');
        return calculateDatasetSummary(args.datasetId, args.columnKey, args.groupBy, context.jobId);
      }),
    tool('compare_observations', '比较结构化观察', '仅在比较字段、指标身份、显式单位和实验条件均完整一致时计算数值差；信息不足时只并列展示。',
      object({ observationIds: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 2, maxItems: 20 }) }), args => {
        const ids = [...new Set<string>(args.observationIds)];
        if (ids.length < 2) throw new Error('至少提供两条不同的结构化记录');
        const rows = ids.map(id => db.prepare(`SELECT o.*,r.title FROM research_observations o JOIN research_reports r ON r.id=o.report_id
          WHERE o.id=? AND r.deleted_at IS NULL`).get(id) as Record<string, any> | undefined);
        if (rows.some(row => !row)) throw new Error('一条或多条结构化记录不存在或来源报告已删除');
        const allowedReports = permittedReportIds(context);
        if (allowedReports && rows.some(row => !allowedReports.includes(String(row!.report_id)))) throw new Error('至少一条结构化记录不在本会话上下文内');
        const values = rows.map(row => {
          const refs = db.prepare('SELECT id,source_version_id,content_sha256 FROM evidence_refs WHERE observation_id=?').all(row!.id) as Record<string, any>[];
          if (!refs.some(ref => readCurrentEvidence(String(ref.id)))) throw new Error('结构化记录没有仍有效的证据引用');
          const review = db.prepare('SELECT * FROM observation_reviews WHERE observation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(row!.id) as Record<string, any> | undefined;
          const resolved = resolveObservationValue(row!.value_json, review);
          return { id: row!.id, reportTitle: row!.title, fieldKey: row!.field_key, observationType: row!.observation_type,
            reviewState: row!.review_state, value: resolved.value, originalValue: resolved.originalValue, evidenceRefs: refs.map(ref => ref.id) };
        });
        return assessObservationComparison(values);
      }),
    tool('calculate_recipe', '计算配方用量', '调用系统确定性配方计算器，按已发布配方版本和目标体积计算各组分。',
      object({ recipeVersionId: Type.String({ minLength: 1, maxLength: 120 }), targetVolume: Type.String({ minLength: 1, maxLength: 40 }), targetVolumeUnit: Type.Optional(Type.String({ maxLength: 24 })) }),
      args => { assertRecipeContext(context, String(args.recipeVersionId)); return toolResultForRecipe(args.recipeVersionId, args.targetVolume, args.targetVolumeUnit || ''); }),
    tool('preview_preparation_allocations', '预览配液批次分配', '按当前已发布配方、目标体积、批次浓度和库存余额计算配液候选，不创建任务也不扣库存。',
      object({ recipeVersionId: Type.String({ minLength: 1, maxLength: 120 }), targetVolume: Type.String({ minLength: 1, maxLength: 40 }), targetVolumeUnit: Type.Optional(Type.String({ maxLength: 24 })) }),
      args => { assertRecipeContext(context, String(args.recipeVersionId)); return previewPreparationAllocations(args.recipeVersionId, args.targetVolume, args.targetVolumeUnit); }),
  ];
  return tools.map(item => ({ ...item, execute: async (toolCallId, args, signal, onUpdate) => {
    const result = await item.execute(toolCallId, args, signal, onUpdate);
    const rawText = result.content?.filter(block => block.type === 'text').map(block => block.text).join('') || '';
    try { onToolResult?.(item.name, JSON.parse(rawText)); } catch { /* Only structured tool output can become a citation. */ }
    return result;
  } }));
}
