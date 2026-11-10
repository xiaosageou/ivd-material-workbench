import { db, id } from '../db.ts';
import { currentReportManifest, type Row } from './jobs.ts';

export type KnowledgeFilters = {
  q?: string;
  reportId?: string;
  reportIds?: string[];
  fieldKey?: string;
  reviewState?: string;
  project?: string;
  experimentType?: string;
  materialLot?: string;
  recipeVersion?: string;
  dateFrom?: string;
  dateTo?: string;
  includeHistory?: boolean;
  limit?: number;
};

const parseJson = (value: unknown, fallback: any = {}) => { try { return JSON.parse(String(value ?? '')); } catch { return fallback; } };
const textOf = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? '').replace(/[{}"\\]/g, ' ');
const hasText = (haystack: string, needle?: string) => !needle || haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());

export function currentAnalysisIds(reportIds?: string[], includeHistory = false) {
  if (reportIds !== undefined && reportIds.length === 0) return [];
  const scope = reportIds !== undefined ? ` AND id IN (${reportIds.map(() => '?').join(',')})` : '';
  const activeReports = db.prepare(`SELECT id FROM research_reports WHERE deleted_at IS NULL${scope}`)
    .all(...(reportIds || [])) as Row[];
  const result: string[] = [];
  for (const report of activeReports) {
    const analyses = db.prepare(`SELECT id,input_manifest_json,status FROM research_analyses WHERE report_id=? AND status!='invalidated' ORDER BY created_at DESC,rowid DESC`)
      .all(report.id) as Row[];
    if (includeHistory) { result.push(...analyses.map(row => String(row.id))); continue; }
    const manifest = currentReportManifest(String(report.id));
    const latest = analyses.find(row => parseJson(row.input_manifest_json).fingerprint === manifest?.fingerprint);
    if (latest) result.push(String(latest.id));
  }
  return result;
}

export function resolveObservationValue(valueJson: unknown, review?: Row) {
  const originalValue = parseJson(valueJson, valueJson);
  const reviewState = String(review?.review_state || '');
  const correctedValue = review?.corrected_value_json ? parseJson(review.corrected_value_json) : undefined;
  const correctionApplied = correctedValue !== undefined && ['corrected', 'human_confirmed'].includes(reviewState);
  return { value: correctionApplied ? correctedValue : originalValue, originalValue, correctedValue, correctionApplied };
}

function validReferences(observationId: string) {
  const refs = db.prepare(`SELECT e.*,r.title FROM evidence_refs e JOIN research_reports r ON r.id=e.report_id
    WHERE e.observation_id=? AND r.deleted_at IS NULL ORDER BY e.created_at,e.id`).all(observationId) as Row[];
  return refs.flatMap(ref => {
    const manifest = currentReportManifest(String(ref.report_id));
    const source = manifest?.sources.find(item => item.id === ref.source_version_id && item.content_sha256 === ref.content_sha256);
    if (!source) return [];
    return [{ id: String(ref.id), reportId: String(ref.report_id), reportTitle: String(ref.title), sourceVersionId: String(ref.source_version_id),
      sourceKind: String(ref.source_kind), contentSha256: String(ref.content_sha256), locator: parseJson(ref.locator_json), excerpt: String(ref.source_excerpt) }];
  });
}

export function searchKnowledge(filters: KnowledgeFilters = {}) {
  const limit = Math.max(1, Math.min(2000, Number(filters.limit || 50)));
  const reportScope = filters.reportIds !== undefined ? filters.reportIds : filters.reportId ? [filters.reportId] : undefined;
  const allowedAnalysisIds = currentAnalysisIds(reportScope, filters.includeHistory === true);
  const observations: Row[] = allowedAnalysisIds.length ? db.prepare(`SELECT o.*,a.summary,a.created_at AS analysis_created,a.input_manifest_json,r.title AS report_title,r.description AS report_description,
      r.created_at AS report_created,r.updated_at AS report_updated
    FROM research_observations o JOIN research_analyses a ON a.id=o.analysis_id JOIN research_reports r ON r.id=o.report_id
    WHERE a.id IN (${allowedAnalysisIds.map(() => '?').join(',')}) AND r.deleted_at IS NULL
    ORDER BY a.created_at DESC,o.created_at DESC LIMIT 2000`).all(...allowedAnalysisIds) as Row[] : [];
  const filtered = observations.flatMap(item => {
    const review = db.prepare('SELECT * FROM observation_reviews WHERE observation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(item.id) as Row | undefined;
    const resolved = resolveObservationValue(item.value_json, review);
    const value = resolved.value;
    const effectiveReviewState = String(review?.review_state || item.review_state);
    let analysisFingerprint = '';
    try { analysisFingerprint = String(parseJson(item.input_manifest_json).fingerprint || ''); } catch { /* treated as historical below */ }
    const manifest = currentReportManifest(String(item.report_id));
    const historical = !manifest || analysisFingerprint !== manifest.fingerprint;
    const refs = validReferences(String(item.id));
    if (!refs.length) return [];
    const body = [item.report_title,item.report_description,item.summary,item.field_key,resolved.correctionApplied ? '' : item.normalized_text,
      textOf(value),...refs.map(ref => ref.excerpt)].join(' ');
    const metadata = [body, textOf(value.project), textOf(value.experiment_type), textOf(value.material_lot), textOf(value.recipe_version)].join(' ');
    if (!hasText(body, filters.q) || !hasText(String(item.field_key), filters.fieldKey) || !hasText(effectiveReviewState, filters.reviewState)
      || !hasText(metadata, filters.project) || !hasText(metadata, filters.experimentType) || !hasText(metadata, filters.materialLot) || !hasText(metadata, filters.recipeVersion)) return [];
    const reportDate = String(item.report_created).slice(0, 10);
    if (filters.dateFrom && reportDate < filters.dateFrom || filters.dateTo && reportDate > filters.dateTo) return [];
    return [{ id: String(item.id), reportId: String(item.report_id), reportTitle: String(item.report_title), reportDescription: String(item.report_description),
      reportDate, fieldKey: String(item.field_key), observationType: String(item.observation_type), reviewState: effectiveReviewState,
      reviewVersion: Number(item.review_version || 1), historical, value,
      originalValue: resolved.originalValue,
      summary: String(item.summary), updatedAt: String(item.updated_at), analysisCreatedAt: String(item.analysis_created), supersedesId: item.supersedes_id || null,
      review: review ? { state: String(review.review_state), correctedValue: review.corrected_value_json ? parseJson(review.corrected_value_json) : undefined,
        comment: String(review.comment || '') } : undefined, evidence: refs }];
  }).slice(0, limit);

  const query = String(filters.q || '').trim();
  const scopeSql = reportScope === undefined ? '' : reportScope.length ? ` AND id IN (${reportScope.map(() => '?').join(',')})` : ' AND 1=0';
  const reports = db.prepare(`SELECT id,title,description,created_at,updated_at FROM research_reports WHERE deleted_at IS NULL${scopeSql}
    AND (?='' OR title LIKE ? OR description LIKE ?) ORDER BY updated_at DESC LIMIT 100`)
    .all(...(reportScope || []), query, `%${query}%`, `%${query}%`) as Row[];
  return { observations: filtered, reports: reports.map(report => ({ id: String(report.id), title: String(report.title), description: String(report.description),
    createdAt: String(report.created_at), updatedAt: String(report.updated_at) })), includeHistory: filters.includeHistory === true };
}

/** Resolve only the observation IDs returned by a trusted retrieval backend. This avoids
 * dropping older hits when a large organization-wide knowledge result is capped. */
export function getCurrentKnowledgeObservationsByIds(observationIds: string[]) {
  const ids = [...new Set(observationIds.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 200);
  if (!ids.length) return [] as Row[];
  const result: Row[] = [];
  for (let offset = 0; offset < ids.length; offset += 300) {
    const batch = ids.slice(offset, offset + 300);
    const rows = db.prepare(`SELECT o.*,a.summary,a.created_at AS analysis_created,a.input_manifest_json,
        r.title AS report_title,r.description AS report_description,r.created_at AS report_created,r.updated_at AS report_updated
      FROM research_observations o JOIN research_analyses a ON a.id=o.analysis_id JOIN research_reports r ON r.id=o.report_id
      WHERE o.id IN (${batch.map(() => '?').join(',')}) AND a.status!='invalidated' AND r.deleted_at IS NULL`).all(...batch) as Row[];
    for (const item of rows) {
      const manifest = currentReportManifest(String(item.report_id));
      if (!manifest || String(parseJson(item.input_manifest_json).fingerprint || '') !== manifest.fingerprint) continue;
      const review = db.prepare('SELECT * FROM observation_reviews WHERE observation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(item.id) as Row | undefined;
      const resolved = resolveObservationValue(item.value_json, review);
      const refs = validReferences(String(item.id));
      if (!refs.length) continue;
      result.push({ id: String(item.id), reportId: String(item.report_id), reportTitle: String(item.report_title), reportDescription: String(item.report_description),
        reportDate: String(item.report_created).slice(0, 10), fieldKey: String(item.field_key), observationType: String(item.observation_type),
        reviewState: String(review?.review_state || item.review_state), reviewVersion: Number(item.review_version || 1), historical: false,
        value: resolved.value, originalValue: resolved.originalValue, summary: String(item.summary), updatedAt: String(item.updated_at),
        analysisCreatedAt: String(item.analysis_created), supersedesId: item.supersedes_id || null,
        review: review ? { state: String(review.review_state), correctedValue: review.corrected_value_json ? parseJson(review.corrected_value_json) : undefined,
          comment: String(review.comment || '') } : undefined, evidence: refs });
    }
  }
  return result;
}

export function readCurrentEvidence(evidenceRefId: string) {
  const ref = db.prepare(`SELECT e.*,r.title FROM evidence_refs e JOIN research_reports r ON r.id=e.report_id WHERE e.id=? AND r.deleted_at IS NULL`)
    .get(evidenceRefId) as Row | undefined;
  if (!ref) return undefined;
  const manifest = currentReportManifest(String(ref.report_id));
  const source = manifest?.sources.find(item => item.id === ref.source_version_id && item.content_sha256 === ref.content_sha256);
  if (!source) return undefined;
  const chunk = db.prepare(`SELECT c.content_text,c.locator_json FROM document_chunks c JOIN document_extractions e ON e.id=c.extraction_id
    WHERE e.report_id=? AND e.source_version_id=? AND e.input_sha256=? ORDER BY e.created_at DESC,c.sequence_no`).all(ref.report_id, ref.source_version_id, ref.content_sha256) as Row[];
  const excerpt = String(ref.source_excerpt || '');
  const matching = chunk.find(row => String(row.content_text).includes(excerpt));
  return { refId: String(ref.id), reportId: String(ref.report_id), reportTitle: String(ref.title), sourceVersionId: String(ref.source_version_id),
    sourceKind: String(ref.source_kind), contentSha256: String(ref.content_sha256), locator: parseJson(ref.locator_json),
    text: matching ? String(matching.content_text) : excerpt, current: true };
}

export function getReportManifestSummary(reportId: string) {
  const manifest = currentReportManifest(reportId);
  if (!manifest) return undefined;
  return { reportId, title: manifest.title, description: manifest.description, fingerprint: manifest.fingerprint,
    reportVersionId: manifest.reportVersionId, sources: manifest.sources.map(source => ({ id: source.id, kind: source.kind, name: source.original_name,
      extension: source.extension, sizeBytes: source.size_bytes, contentSha256: source.content_sha256 })) };
}

function safeNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function calculateStats(values: number[]) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, sampleStandardDeviation: null, cvPercent: null, reason: '所选范围没有可计算的数值。' };
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const sampleStandardDeviation = n > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : null;
  return { n, mean: Number(mean.toPrecision(12)), sampleStandardDeviation: sampleStandardDeviation === null ? null : Number(sampleStandardDeviation.toPrecision(12)),
    cvPercent: sampleStandardDeviation === null || mean === 0 ? null : Number((Math.abs(sampleStandardDeviation / mean) * 100).toPrecision(8)),
    reason: mean === 0 ? '均值为零，CV 不计算。' : n < 2 ? '少于两个数值，样本标准差和 CV 不计算。' : undefined };
}

export function calculateDatasetSummary(datasetId: string, columnKey: string, groupBy: string | undefined, createdByJobId: string) {
  const dataset = db.prepare(`SELECT d.*,e.report_id,e.source_version_id,e.input_sha256 FROM document_datasets d
    JOIN document_extractions e ON e.id=d.extraction_id WHERE d.id=?`).get(datasetId) as Row | undefined;
  if (!dataset) throw new Error('所选数据集不存在');
  const manifest = currentReportManifest(String(dataset.report_id));
  if (!manifest?.sources.some(source => source.id === dataset.source_version_id && source.content_sha256 === dataset.input_sha256)) throw new Error('数据集来源已更新或已删除，不能参与计算');
  const columns = parseJson(dataset.columns_json, []) as Array<{ key: string; label: string; unit?: string }>;
  const selected = columns.find(column => column.key === columnKey);
  if (!selected) throw new Error('数据列不存在');
  if (groupBy && !columns.some(column => column.key === groupBy)) throw new Error('分组列不存在');
  const rows = db.prepare('SELECT row_number,values_json FROM document_dataset_rows WHERE dataset_id=? ORDER BY row_number').all(datasetId) as Row[];
  const groups = new Map<string, number[]>();
  let missing = 0;
  for (const row of rows) {
    const values = parseJson(row.values_json, {});
    const numeric = safeNumber(values[columnKey]);
    if (numeric === undefined) { missing++; continue; }
    const group = groupBy ? textOf(values[groupBy] ?? '(空组)') : '全部';
    groups.set(group, [...(groups.get(group) || []), numeric]);
  }
  const result = [...groups].map(([group, values]) => ({ group, ...calculateStats(values) }));
  const method = { methodVersion: '1', statistic: 'mean and sample standard deviation; CV = sample SD / absolute mean × 100', rowStart: dataset.row_start,
    rowEnd: dataset.row_end, numericCount: result.reduce((sum, item) => sum + item.n, 0), missingOrNonNumericCount: missing,
    unit: selected.unit || null, column: selected, groupBy: groupBy ? columns.find(column => column.key === groupBy) : null, groups: result };
  db.prepare(`INSERT INTO analysis_calculations(id,report_id,source_version_id,dataset_range_json,method_version,parameters_json,result_json,created_by_job_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(id('calc_'), dataset.report_id, dataset.source_version_id,
      JSON.stringify({ datasetId, rowStart: dataset.row_start, rowEnd: dataset.row_end, contentSha256: dataset.input_sha256 }), '1',
      JSON.stringify({ columnKey, groupBy: groupBy || null, missingPolicy: 'skip and count' }), JSON.stringify(method), createdByJobId || null);
  return method;
}
