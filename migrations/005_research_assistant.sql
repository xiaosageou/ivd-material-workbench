CREATE TABLE ai_outbox_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  report_id TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  available_at_ms INTEGER NOT NULL,
  processed_at TEXT,
  error_message TEXT
);

CREATE TABLE ai_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('report_analysis','assistant_chat','recipe_suggestion','preparation_suggestion')),
  report_id TEXT REFERENCES research_reports(id),
  requested_by TEXT REFERENCES users(id),
  input_fingerprint TEXT NOT NULL,
  input_manifest_json TEXT NOT NULL DEFAULT '{}',
  run_key TEXT NOT NULL DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','waiting_configuration','parsing','analyzing','validating','completed','partial','failed','cancelled','superseded')),
  progress_json TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  provider TEXT,
  model TEXT,
  parser_version TEXT NOT NULL DEFAULT '1',
  schema_version TEXT NOT NULL DEFAULT '1',
  prompt_version TEXT NOT NULL DEFAULT '1',
  budget_tokens INTEGER NOT NULL DEFAULT 8192,
  timeout_ms INTEGER NOT NULL DEFAULT 90000,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_type, input_fingerprint, run_key)
);

CREATE TABLE ai_job_inputs (
  job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  input_kind TEXT NOT NULL CHECK (input_kind IN ('report','report_version','data_attachment_version')),
  source_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  storage_key TEXT,
  original_name TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(job_id, position)
);

CREATE TABLE ai_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, sequence_no)
);

CREATE TABLE document_extractions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES research_reports(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('report_version','data_attachment_version')),
  source_version_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('parsed','partial','unsupported','failed')),
  coverage_json TEXT NOT NULL DEFAULT '{}',
  text_length INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_kind, source_version_id, input_sha256, parser_version)
);

CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  extraction_id TEXT NOT NULL REFERENCES document_extractions(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  locator_json TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(extraction_id, sequence_no)
);

CREATE TABLE research_analyses (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES ai_jobs(id),
  report_id TEXT NOT NULL REFERENCES research_reports(id),
  report_version_id TEXT NOT NULL REFERENCES research_report_versions(id),
  status TEXT NOT NULL CHECK (status IN ('completed','partial','needs_review','failed','superseded','invalidated')),
  summary TEXT NOT NULL DEFAULT '',
  structured_json TEXT NOT NULL DEFAULT '{}',
  evidence_gaps_json TEXT NOT NULL DEFAULT '[]',
  coverage_json TEXT NOT NULL DEFAULT '{}',
  input_manifest_json TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE research_observations (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES research_reports(id),
  analysis_id TEXT REFERENCES research_analyses(id),
  field_key TEXT NOT NULL,
  observation_type TEXT NOT NULL CHECK (observation_type IN ('source_statement','program_calculation','agent_inference','human_entry')),
  review_state TEXT NOT NULL DEFAULT 'machine_unconfirmed' CHECK (review_state IN ('machine_unconfirmed','human_confirmed','conflict','stale','invalidated')),
  value_json TEXT NOT NULL,
  normalized_text TEXT NOT NULL DEFAULT '',
  review_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE evidence_refs (
  id TEXT PRIMARY KEY,
  observation_id TEXT REFERENCES research_observations(id) ON DELETE CASCADE,
  analysis_id TEXT REFERENCES research_analyses(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES research_reports(id),
  source_version_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('report_version','data_attachment_version')),
  content_sha256 TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  source_excerpt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE observation_reviews (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES research_observations(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  review_state TEXT NOT NULL CHECK (review_state IN ('human_confirmed','corrected','conflict','stale')),
  corrected_value_json TEXT,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE analysis_calculations (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES research_reports(id),
  source_version_id TEXT NOT NULL,
  dataset_range_json TEXT NOT NULL,
  method_version TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_by_job_id TEXT REFERENCES ai_jobs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assistant_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  context_type TEXT NOT NULL CHECK (context_type IN ('knowledge_base','report','reports','recipe')),
  context_ids_json TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL DEFAULT '新会话',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
  job_id TEXT REFERENCES ai_jobs(id),
  citations_json TEXT NOT NULL DEFAULT '[]',
  tool_trace_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, sequence_no)
);

CREATE TABLE ai_suggestions (
  id TEXT PRIMARY KEY,
  suggestion_type TEXT NOT NULL CHECK (suggestion_type IN ('recipe','preparation')),
  report_id TEXT REFERENCES research_reports(id),
  recipe_version_id TEXT REFERENCES recipe_versions(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  job_id TEXT REFERENCES ai_jobs(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','needs_input','invalid','confirmed','cancelled')),
  payload_json TEXT NOT NULL,
  validation_json TEXT NOT NULL DEFAULT '{}',
  cited_refs_json TEXT NOT NULL DEFAULT '[]',
  expected_version TEXT NOT NULL DEFAULT '',
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  result_type TEXT,
  result_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ai_confirmations (
  idempotency_key TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL UNIQUE REFERENCES ai_suggestions(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  result_type TEXT NOT NULL,
  result_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ai_worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  process_id INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'online'
);

CREATE INDEX idx_ai_outbox_ready ON ai_outbox_events(processed_at, available_at_ms);
CREATE INDEX idx_ai_jobs_claim ON ai_jobs(status, lease_until_ms, created_at);
CREATE INDEX idx_ai_jobs_report ON ai_jobs(report_id, created_at DESC);
CREATE INDEX idx_ai_job_events ON ai_job_events(job_id, sequence_no);
CREATE INDEX idx_document_extractions_report ON document_extractions(report_id, created_at DESC);
CREATE INDEX idx_document_chunks_search ON document_chunks(extraction_id, sequence_no);
CREATE INDEX idx_research_observations_report ON research_observations(report_id, updated_at DESC);
CREATE INDEX idx_research_observations_search ON research_observations(review_state, field_key);
CREATE INDEX idx_evidence_refs_report ON evidence_refs(report_id, source_version_id);
CREATE INDEX idx_assistant_sessions_owner ON assistant_sessions(owner_id, updated_at DESC);
CREATE INDEX idx_ai_suggestions_owner ON ai_suggestions(owner_id, created_at DESC);
