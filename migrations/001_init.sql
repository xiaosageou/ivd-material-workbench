CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','RESEARCHER')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES locations(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('mass','volume','amount','activity','count')),
  base_unit TEXT NOT NULL,
  specification TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  default_supplier TEXT NOT NULL DEFAULT '',
  min_stock TEXT NOT NULL DEFAULT '0',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  is_product INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'team' CHECK (scope IN ('team','personal')),
  owner_id TEXT REFERENCES users(id),
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','demo','imported','ai_draft')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS recipe_versions (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  base_volume TEXT NOT NULL,
  base_volume_unit TEXT NOT NULL,
  output_name TEXT NOT NULL,
  output_code TEXT NOT NULL,
  output_unit TEXT NOT NULL,
  output_dimension TEXT NOT NULL DEFAULT 'volume' CHECK (output_dimension IN ('mass','volume','amount','activity','count')),
  steps_json TEXT NOT NULL DEFAULT '[]',
  storage TEXT NOT NULL DEFAULT '',
  source_note TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  UNIQUE(recipe_id, version)
);
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id TEXT PRIMARY KEY,
  recipe_version_id TEXT NOT NULL REFERENCES recipe_versions(id) ON DELETE CASCADE,
  material_id TEXT REFERENCES materials(id),
  name TEXT NOT NULL,
  calculation_type TEXT NOT NULL CHECK (calculation_type IN ('ratio','mass_concentration','molar_concentration','stock_dilution','volume_fraction','fixed_addition')),
  amount_value TEXT NOT NULL,
  amount_unit TEXT NOT NULL,
  stock_concentration TEXT NOT NULL DEFAULT '',
  target_concentration TEXT NOT NULL DEFAULT '',
  molecular_weight TEXT NOT NULL DEFAULT '',
  dimension TEXT NOT NULL CHECK (dimension IN ('mass','volume','amount','activity','count')),
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS preparations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  recipe_version_id TEXT NOT NULL REFERENCES recipe_versions(id),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','aborted','corrected')),
  target_volume TEXT NOT NULL,
  target_volume_unit TEXT NOT NULL,
  output_quantity TEXT NOT NULL DEFAULT '',
  output_unit TEXT NOT NULL DEFAULT '',
  measured_ph TEXT NOT NULL DEFAULT '',
  deviation TEXT NOT NULL DEFAULT '',
  theoretical_snapshot TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  correction_note TEXT NOT NULL DEFAULT '',
  performed_by TEXT NOT NULL REFERENCES users(id),
  completed_at TEXT,
  aborted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS preparation_steps (
  id TEXT PRIMARY KEY,
  preparation_id TEXT NOT NULL REFERENCES preparations(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  instruction TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  performed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory_lots (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id),
  manufacturer_lot TEXT NOT NULL DEFAULT '',
  internal_lot TEXT NOT NULL UNIQUE,
  expiry_date TEXT,
  concentration TEXT NOT NULL DEFAULT '',
  concentration_unit TEXT NOT NULL DEFAULT '',
  purity TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','disabled','expired')),
  container_id TEXT NOT NULL DEFAULT '',
  source_preparation_id TEXT REFERENCES preparations(id),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS stock_balances (
  lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  quantity TEXT NOT NULL DEFAULT '0',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(lot_id, location_id)
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  material_id TEXT NOT NULL REFERENCES materials(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('RECEIVE','USE','TRANSFER_OUT','TRANSFER_IN','LOSS','ADJUST_IN','ADJUST_OUT','PREPARATION_USE','REVERSAL')),
  quantity TEXT NOT NULL,
  from_location_id TEXT REFERENCES locations(id),
  to_location_id TEXT REFERENCES locations(id),
  reason TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS preparation_ingredient_usage (
  id TEXT PRIMARY KEY,
  preparation_id TEXT NOT NULL REFERENCES preparations(id),
  ingredient_name TEXT NOT NULL,
  lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  theoretical_quantity TEXT NOT NULL,
  actual_quantity TEXT NOT NULL,
  unit TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lots_material ON inventory_lots(material_id);
CREATE INDEX IF NOT EXISTS idx_movements_lot ON stock_movements(lot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_preparations_status ON preparations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
