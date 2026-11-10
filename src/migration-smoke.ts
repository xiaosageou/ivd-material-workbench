import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`MIGRATION SMOKE FAIL: ${message}`); };
const dataDir = mkdtempSync(join(tmpdir(), 'ivd-migration-smoke-'));
try {
  const legacy = new DatabaseSync(join(dataDir, 'ivd.sqlite'));
  legacy.exec(readFileSync('migrations/001_init.sql', 'utf8'));
  legacy.prepare(`INSERT INTO users(id,name,email,password_hash,role) VALUES (?,?,?,?,?)`).run('legacy-user','历史负责人','legacy@example.test','fixture','ADMIN');
  legacy.prepare(`INSERT INTO users(id,name,email,password_hash,role) VALUES (?,?,?,?,?)`).run('legacy-author','历史版本作者','author@example.test','fixture','RESEARCHER');
  legacy.prepare(`INSERT INTO locations(id,code,name) VALUES (?,?,?)`).run('legacy-location','LEGACY-A','历史库位');
  legacy.prepare(`INSERT INTO materials(id,code,name,category,dimension,base_unit) VALUES (?,?,?,?,?,?)`).run('legacy-material','LEGACY-001','历史物料','试剂','mass','mg');
  legacy.prepare(`INSERT INTO recipes(id,name,scope,owner_id) VALUES (?,?,?,?)`).run('legacy-recipe','历史个人配方','personal','legacy-user');
  legacy.prepare(`INSERT INTO recipe_versions(id,recipe_id,version,status,base_volume,base_volume_unit,output_name,output_code,output_unit,created_by)
    VALUES (?,?,1,'draft','10','mL','历史产物','LEGACY-PRODUCT','mL','legacy-author')`).run('legacy-version','legacy-recipe');
  legacy.prepare(`INSERT INTO preparations(id,code,recipe_version_id,target_volume,target_volume_unit,output_quantity,output_unit,theoretical_snapshot,performed_by)
    VALUES (?,?,?,'10','mL','10','mL','{"recipeName":"历史个人配方","version":1,"lines":[]}','legacy-user')`)
    .run('legacy-prep','LEGACY-PREP','legacy-version');
  legacy.prepare(`INSERT INTO inventory_lots(id,material_id,internal_lot) VALUES (?,?,?)`).run('legacy-lot','legacy-material','LEGACY-LOT');
  legacy.prepare(`INSERT INTO stock_balances(lot_id,location_id,quantity) VALUES (?,?,?)`).run('legacy-lot','legacy-location','2.5');
  legacy.close();

  process.env.DATA_DIR = dataDir;
  const upgraded = await import('./db.ts');
  const version = (upgraded.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version;
  assert(version === 12, '增量迁移写入版本 12');
  const lot = upgraded.db.prepare(`SELECT b.quantity,m.name FROM stock_balances b JOIN materials m ON m.id='legacy-material' WHERE b.lot_id='legacy-lot'`).get() as any;
  assert(lot?.quantity === '2.5' && lot?.name === '历史物料', '旧物料与库存余额完整保留');
  const recipe = upgraded.db.prepare('SELECT scope,created_by FROM recipes WHERE id=?').get('legacy-recipe') as any;
  assert(recipe.scope === 'team' && recipe.created_by === 'legacy-user', '历史个人配方迁移为组织共享并保留配方创建人');
  const legacyVersionAuthor = upgraded.db.prepare('SELECT created_by FROM recipe_versions WHERE id=?').get('legacy-version') as any;
  assert(legacyVersionAuthor.created_by === 'legacy-author', '历史配方版本作者分别保留，不与配方创建人混淆');
  const prep = upgraded.db.prepare('SELECT created_by,completed_by,performed_by FROM preparations WHERE id=?').get('legacy-prep') as any;
  assert(prep.created_by === 'legacy-user' && prep.performed_by === 'legacy-user' && prep.completed_by === null, '历史配液保留原有负责人并标明完成执行人未知');
  assert((upgraded.db.prepare('PRAGMA table_info(preparations)').all() as any[]).some(column=>column.name==='aborted_by'),'v3 增量迁移添加中止执行人字段');
  assert((upgraded.db.prepare('PRAGMA table_info(research_observations)').all() as any[]).some(column=>column.name==='supersedes_id'),'v6 增量迁移保留结构化知识修订链');
  const usageColumns = upgraded.db.prepare('PRAGMA table_info(ai_jobs)').all() as any[];
  assert(['usage_input_tokens','usage_output_tokens','usage_cache_read_tokens','usage_cache_write_tokens','usage_total_tokens',
    'usage_request_count','usage_pending_count','usage_unknown_count','usage_status','usage_stop_reason',
    'usage_last_response_id','usage_last_provider_stop_reason']
    .every(name => usageColumns.some(column => column.name === name)), 'v8 增量迁移添加任务累计 token 用量与停止原因');
  for (const table of ['research_reports','research_report_versions','research_report_data_attachments','research_report_data_versions',
    'ai_outbox_events','ai_jobs','ai_job_inputs','document_extractions','document_chunks','research_analyses','research_observations',
    'evidence_refs','observation_reviews','assistant_sessions','assistant_messages','ai_suggestions','ai_confirmations','document_datasets','document_dataset_rows']) {
    assert(Boolean(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)),`v5 增量迁移建立 ${table}`);
  }
  for (const table of ['literature_items','literature_metadata_versions','literature_file_versions','literature_collections','literature_item_collections',
    'literature_tags','literature_item_tags','literature_extractions','literature_chunks','literature_embedding_profiles','literature_embedding_cache',
    'literature_index_generations','literature_jobs','literature_job_events','literature_worker_heartbeats','literature_evidence_refs','literature_session_scopes','literature_chunks_fts']) {
    assert(Boolean(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)),`v9 增量迁移建立 ${table}`);
  }
  assert(Boolean(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='literature_query_usage'").get()), 'v10 增量迁移建立按用户与日期累计的文献检索用量表');
  assert((upgraded.db.prepare('PRAGMA table_info(recipe_versions)').all() as any[]).some(column=>column.name==='target_ph'), 'v11 增量迁移添加可选配方目标 pH');
  assert(Boolean(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_knowledge_index_jobs'").get()), 'v12 增量迁移建立独立研发报告知识向量索引队列');
  assert(Boolean(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_knowledge_embedding_cache'").get()), 'v12 增量迁移建立可随本地备份恢复的报告向量缓存');
  upgraded.db.close();
  console.log('MIGRATION SMOKE PASS: v1 既有库存保留、配方组织共享、配液操作者迁移留痕、报告/研发助手/文献版本与索引任务表增量创建、知识修订链/任务累计用量/目标 pH/报告向量恢复表增量创建，v12 迁移完成。');
} finally {
  rmSync(dataDir,{recursive:true,force:true});
}
import './test-isolation.mjs';
