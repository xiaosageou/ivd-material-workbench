ALTER TABLE users ADD COLUMN registration_pending INTEGER NOT NULL DEFAULT 0 CHECK(registration_pending IN (0,1));
