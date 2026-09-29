CREATE TABLE simple_work_assessment_preferences (
  person_id text PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE simple_work_assessments (
  item_id text PRIMARY KEY REFERENCES simple_items(id) ON DELETE CASCADE,
  input_key text NOT NULL CHECK (input_key ~ '^[0-9a-f]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
