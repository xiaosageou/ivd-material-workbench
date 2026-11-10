ALTER TABLE preparations ADD COLUMN aborted_by TEXT REFERENCES users(id);
