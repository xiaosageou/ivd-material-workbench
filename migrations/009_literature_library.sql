CREATE TABLE literature_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 500),
  authors_json TEXT NOT NULL DEFAULT '[]',
  publication_year INTEGER CHECK(publication_year IS NULL OR publication_year BETWEEN 1000 AND 3000),
  journal TEXT NOT NULL DEFAULT '',
  doi TEXT NOT NULL DEFAULT '',
  doi_normalized TEXT NOT NULL DEFAULT '',
  pmid TEXT NOT NULL DEFAULT '',
  original_url TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  abstract TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  current_version_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id)
);

CREATE TABLE literature_metadata_versions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES literature_items(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  snapshot_json TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, revision)
);

CREATE TABLE literature_file_versions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES literature_items(id),
  version_no INTEGER NOT NULL CHECK(version_no > 0),
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  extension TEXT NOT NULL CHECK(extension IN ('.pdf','.docx','.txt','.md')),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 26214400),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  change_note TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, version_no)
);

CREATE TABLE literature_collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_literature_collection_active_name ON literature_collections(name COLLATE NOCASE) WHERE deleted_at IS NULL;

CREATE TABLE literature_item_collections (
  item_id TEXT NOT NULL REFERENCES literature_items(id),
  collection_id TEXT NOT NULL REFERENCES literature_collections(id),
  added_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(item_id, collection_id)
);

CREATE TABLE literature_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE literature_item_tags (
  item_id TEXT NOT NULL REFERENCES literature_items(id),
  tag_id TEXT NOT NULL REFERENCES literature_tags(id),
  PRIMARY KEY(item_id, tag_id)
);

CREATE TABLE literature_extractions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES literature_items(id),
  version_id TEXT NOT NULL REFERENCES literature_file_versions(id),
  input_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('parsed','partial','needs_ocr','unsupported','failed')),
  coverage_json TEXT NOT NULL DEFAULT '{}',
  page_count INTEGER NOT NULL DEFAULT 0 CHECK(page_count >= 0),
  pages_read INTEGER NOT NULL DEFAULT 0 CHECK(pages_read >= 0),
  text_length INTEGER NOT NULL DEFAULT 0 CHECK(text_length >= 0),
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(version_id, input_sha256, parser_version)
);

CREATE TABLE literature_chunks (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES literature_items(id),
  version_id TEXT REFERENCES literature_file_versions(id),
  extraction_id TEXT REFERENCES literature_extractions(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK(sequence_no >= 0),
  source_extent TEXT NOT NULL CHECK(source_extent IN ('metadata','abstract','full_text')),
  locator_json TEXT NOT NULL DEFAULT '{}',
  section_title TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(extraction_id, sequence_no)
);

CREATE TABLE literature_embedding_profiles (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  endpoint_url TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions > 0),
  distance TEXT NOT NULL CHECK(distance IN ('Cosine','Dot','Euclid','Manhattan')),
  document_prefix TEXT NOT NULL DEFAULT '',
  query_prefix TEXT NOT NULL DEFAULT '',
  send_dimensions INTEGER NOT NULL DEFAULT 0 CHECK(send_dimensions IN (0,1)),
  chunker_version TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE literature_embedding_cache (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES literature_chunks(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES literature_embedding_profiles(id),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64),
  dimensions INTEGER NOT NULL CHECK(dimensions > 0),
  vector_blob BLOB NOT NULL,
  vector_sha256 TEXT NOT NULL CHECK(length(vector_sha256) = 64),
  usage_tokens INTEGER CHECK(usage_tokens IS NULL OR usage_tokens >= 0),
  usage_status TEXT NOT NULL CHECK(usage_status IN ('known','unknown')),
  response_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chunk_id, profile_id, input_sha256)
);

CREATE TABLE literature_index_generations (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES literature_items(id),
  version_id TEXT REFERENCES literature_file_versions(id),
  profile_id TEXT NOT NULL REFERENCES literature_embedding_profiles(id),
  generation_no INTEGER NOT NULL CHECK(generation_no > 0),
  status TEXT NOT NULL CHECK(status IN ('queued','building','ready','partial','failed','stale','cancelled')),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count >= 0),
  indexed_count INTEGER NOT NULL DEFAULT 0 CHECK(indexed_count >= 0),
  manifest_sha256 TEXT NOT NULL DEFAULT '',
  collection_name TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, version_id, profile_id, generation_no)
);

CREATE TABLE literature_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK(job_type IN ('parse','index','delete_index','rebuild','query')),
  item_id TEXT REFERENCES literature_items(id),
  version_id TEXT REFERENCES literature_file_versions(id),
  profile_id TEXT REFERENCES literature_embedding_profiles(id),
  generation_id TEXT REFERENCES literature_index_generations(id),
  requested_by TEXT REFERENCES users(id),
  input_fingerprint TEXT NOT NULL,
  run_key TEXT NOT NULL DEFAULT 'auto',
  config_snapshot_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','waiting_configuration','parsing','embedding','publishing','completed','partial','failed','cancelled','superseded')),
  progress_json TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5),
  lease_owner TEXT,
  lease_until_ms INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  error_code TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  budget_tokens INTEGER NOT NULL DEFAULT 100000 CHECK(budget_tokens >= 0),
  budget_requests INTEGER NOT NULL DEFAULT 200 CHECK(budget_requests >= 0),
  usage_tokens INTEGER NOT NULL DEFAULT 0 CHECK(usage_tokens >= 0),
  usage_request_count INTEGER NOT NULL DEFAULT 0 CHECK(usage_request_count >= 0),
  usage_pending_count INTEGER NOT NULL DEFAULT 0 CHECK(usage_pending_count >= 0),
  usage_unknown_count INTEGER NOT NULL DEFAULT 0 CHECK(usage_unknown_count >= 0),
  usage_status TEXT NOT NULL DEFAULT 'none' CHECK(usage_status IN ('none','known','unknown','partial_unknown')),
  usage_stop_reason TEXT NOT NULL DEFAULT '',
  usage_last_response_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_type, input_fingerprint, run_key)
);

CREATE TABLE literature_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES literature_jobs(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, sequence_no)
);

CREATE TABLE literature_worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  process_id INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',
  active_job_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE literature_evidence_refs (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES literature_items(id),
  version_id TEXT REFERENCES literature_file_versions(id),
  chunk_id TEXT REFERENCES literature_chunks(id),
  extraction_sha256 TEXT NOT NULL DEFAULT '',
  content_sha256 TEXT NOT NULL DEFAULT '',
  profile_id TEXT REFERENCES literature_embedding_profiles(id),
  locator_json TEXT NOT NULL DEFAULT '{}',
  excerpt TEXT NOT NULL,
  source_extent TEXT NOT NULL CHECK(source_extent IN ('metadata','abstract','full_text')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE literature_session_scopes (
  session_id TEXT PRIMARY KEY REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  scope_type TEXT NOT NULL CHECK(scope_type IN ('items','collections','reports_literature')),
  literature_ids_json TEXT NOT NULL DEFAULT '[]',
  report_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_literature_items_active ON literature_items(deleted_at, updated_at DESC);
CREATE INDEX idx_literature_items_doi ON literature_items(doi_normalized);
CREATE INDEX idx_literature_versions_item ON literature_file_versions(item_id, version_no DESC);
CREATE INDEX idx_literature_metadata_versions ON literature_metadata_versions(item_id, revision DESC);
CREATE INDEX idx_literature_item_collections ON literature_item_collections(collection_id, item_id);
CREATE INDEX idx_literature_item_tags ON literature_item_tags(tag_id, item_id);
CREATE INDEX idx_literature_extractions_item ON literature_extractions(item_id, created_at DESC);
CREATE INDEX idx_literature_chunks_item ON literature_chunks(item_id, source_extent, sequence_no);
CREATE INDEX idx_literature_embedding_cache_profile ON literature_embedding_cache(profile_id, input_sha256);
CREATE INDEX idx_literature_index_status ON literature_index_generations(item_id, status, created_at DESC);
CREATE INDEX idx_literature_jobs_claim ON literature_jobs(status, lease_until_ms, created_at);
CREATE INDEX idx_literature_jobs_item ON literature_jobs(item_id, created_at DESC);
CREATE INDEX idx_literature_job_events ON literature_job_events(job_id, sequence_no);
CREATE INDEX idx_literature_evidence_item ON literature_evidence_refs(item_id, version_id, chunk_id);

CREATE VIRTUAL TABLE literature_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  item_id UNINDEXED,
  title,
  authors,
  abstract,
  keywords,
  content,
  tokenize='trigram'
);

CREATE TRIGGER literature_chunks_fts_insert AFTER INSERT ON literature_chunks BEGIN
  INSERT INTO literature_chunks_fts(chunk_id,item_id,title,authors,abstract,keywords,content)
  SELECT NEW.id, i.id, i.title, i.authors_json, i.abstract, i.keywords_json, NEW.content_text
  FROM literature_items i WHERE i.id=NEW.item_id;
END;

CREATE TRIGGER literature_chunks_fts_delete AFTER DELETE ON literature_chunks BEGIN
  DELETE FROM literature_chunks_fts WHERE chunk_id=OLD.id;
END;
