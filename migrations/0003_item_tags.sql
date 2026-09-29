ALTER TABLE items
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}'::text[]
  CHECK (cardinality(tags) <= 20);
