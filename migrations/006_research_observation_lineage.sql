ALTER TABLE research_observations ADD COLUMN supersedes_id TEXT REFERENCES research_observations(id);
CREATE INDEX idx_research_observations_supersedes ON research_observations(supersedes_id);
