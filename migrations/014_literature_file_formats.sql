CREATE TABLE literature_file_versions_new (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES literature_items(id),
  version_no INTEGER NOT NULL CHECK(version_no > 0), original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE, extension TEXT NOT NULL, mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0), sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  change_note TEXT NOT NULL DEFAULT '', uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(item_id, version_no)
);
INSERT INTO literature_file_versions_new SELECT * FROM literature_file_versions;
DROP TABLE literature_file_versions;
ALTER TABLE literature_file_versions_new RENAME TO literature_file_versions;
CREATE INDEX idx_literature_versions_item ON literature_file_versions(item_id, version_no DESC);
