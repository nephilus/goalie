CREATE TABLE simple_update_mentions (
  update_id text NOT NULL REFERENCES simple_updates(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  PRIMARY KEY (update_id, person_id)
);
CREATE INDEX simple_update_mentions_person_idx ON simple_update_mentions(person_id);
