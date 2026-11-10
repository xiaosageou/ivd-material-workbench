ALTER TABLE recipes ADD COLUMN created_by TEXT REFERENCES users(id);
UPDATE recipes
SET created_by=COALESCE(owner_id,(SELECT v.created_by FROM recipe_versions v WHERE v.recipe_id=recipes.id ORDER BY v.version LIMIT 1))
WHERE created_by IS NULL;
UPDATE recipes SET scope='team' WHERE scope!='team';
ALTER TABLE recipe_versions ADD COLUMN published_by TEXT REFERENCES users(id);
ALTER TABLE recipe_versions ADD COLUMN retired_by TEXT REFERENCES users(id);
ALTER TABLE recipe_versions ADD COLUMN retired_at TEXT;

ALTER TABLE preparations ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE preparations ADD COLUMN completed_by TEXT REFERENCES users(id);
ALTER TABLE preparations ADD COLUMN immediate_use INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preparations ADD COLUMN immediate_use_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE preparations ADD COLUMN deviation_confirmed INTEGER NOT NULL DEFAULT 0;
UPDATE preparations SET created_by=performed_by WHERE created_by IS NULL;

ALTER TABLE preparation_ingredient_usage ADD COLUMN batch_concentration TEXT NOT NULL DEFAULT '';
ALTER TABLE preparation_ingredient_usage ADD COLUMN batch_concentration_unit TEXT NOT NULL DEFAULT '';
ALTER TABLE preparation_ingredient_usage ADD COLUMN allocation_share TEXT NOT NULL DEFAULT '100';

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO system_settings(setting_key,setting_value) VALUES
  ('categories','["无机盐","抗体","抗原","缓冲液","耗材","自制试剂","其他"]'),
  ('units','[]'),
  ('number_rules','{"materialPrefix":"MAT","lotPrefix":"LOT","preparationPrefix":"PREP"}'),
  ('alert_rules','{"expiringDays":60,"defaultMinStock":"0"}');
