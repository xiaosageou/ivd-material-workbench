CREATE TABLE document_datasets (
  id TEXT PRIMARY KEY,
  extraction_id TEXT NOT NULL REFERENCES document_extractions(id) ON DELETE CASCADE,
  dataset_name TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  row_start INTEGER NOT NULL,
  row_end INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE document_dataset_rows (
  dataset_id TEXT NOT NULL REFERENCES document_datasets(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  values_json TEXT NOT NULL,
  PRIMARY KEY(dataset_id,row_number)
);

CREATE INDEX idx_document_datasets_extraction ON document_datasets(extraction_id,dataset_name);
