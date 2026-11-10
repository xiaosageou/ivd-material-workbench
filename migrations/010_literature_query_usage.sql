CREATE TABLE literature_query_usage (
  owner_id TEXT NOT NULL REFERENCES users(id),
  profile_id TEXT NOT NULL REFERENCES literature_embedding_profiles(id),
  usage_date TEXT NOT NULL,
  token_budget INTEGER NOT NULL CHECK(token_budget >= 0),
  request_budget INTEGER NOT NULL CHECK(request_budget >= 0),
  used_tokens INTEGER NOT NULL DEFAULT 0 CHECK(used_tokens >= 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count >= 0),
  pending_count INTEGER NOT NULL DEFAULT 0 CHECK(pending_count >= 0),
  unknown_count INTEGER NOT NULL DEFAULT 0 CHECK(unknown_count >= 0),
  usage_status TEXT NOT NULL DEFAULT 'known' CHECK(usage_status IN ('known','unknown','partial_unknown')),
  stop_reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(owner_id, profile_id, usage_date)
);
CREATE INDEX idx_literature_query_usage_date ON literature_query_usage(usage_date, owner_id);
ALTER TABLE literature_chunks ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE literature_evidence_refs ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0;
