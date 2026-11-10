CREATE TABLE IF NOT EXISTS report_knowledge_index_jobs (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  knowledge_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','waiting_configuration','working','complete','partial','failed','superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  usage_tokens INTEGER NOT NULL DEFAULT 0,
  usage_status TEXT NOT NULL DEFAULT 'none' CHECK (usage_status IN ('none','known','unknown','partial_unknown')),
  error_code TEXT,
  error_message TEXT,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  UNIQUE(report_id, knowledge_fingerprint)
);
CREATE INDEX IF NOT EXISTS report_knowledge_index_jobs_queue_idx
  ON report_knowledge_index_jobs(status, updated_at);
CREATE TABLE IF NOT EXISTS report_knowledge_embedding_cache (
  profile_id TEXT NOT NULL REFERENCES literature_embedding_profiles(id),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  dimensions INTEGER NOT NULL CHECK(dimensions>0),
  vector_blob BLOB NOT NULL,
  vector_sha256 TEXT NOT NULL CHECK(length(vector_sha256)=64),
  usage_tokens INTEGER,
  usage_status TEXT NOT NULL CHECK(usage_status IN ('known','unknown')),
  response_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(profile_id,input_sha256)
);
