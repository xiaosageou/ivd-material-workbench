CREATE TABLE research_reports (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id)
);

CREATE TABLE research_report_versions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES research_reports(id),
  version_no INTEGER NOT NULL CHECK(version_no > 0),
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  extension TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  change_note TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(report_id, version_no)
);

CREATE TABLE research_report_data_attachments (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES research_reports(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id)
);

CREATE TABLE research_report_data_versions (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES research_report_data_attachments(id),
  version_no INTEGER NOT NULL CHECK(version_no > 0),
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  extension TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(attachment_id, version_no)
);

CREATE INDEX idx_research_reports_active ON research_reports(deleted_at, updated_at DESC);
CREATE INDEX idx_research_report_versions ON research_report_versions(report_id, version_no DESC);
CREATE INDEX idx_research_report_data ON research_report_data_attachments(report_id, deleted_at);
CREATE INDEX idx_research_report_data_versions ON research_report_data_versions(attachment_id, version_no DESC);
