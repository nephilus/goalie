ALTER TABLE simple_items
  ADD COLUMN blocker_baseline text NOT NULL DEFAULT '';

UPDATE simple_items SET blocker_baseline = blocker;

ALTER TABLE simple_items
  ADD CONSTRAINT simple_items_blocker_baseline_length CHECK (length(blocker_baseline) <= 4000);

ALTER TABLE simple_updates
  ADD COLUMN kind text NOT NULL DEFAULT 'note';

ALTER TABLE simple_updates
  ADD CONSTRAINT simple_updates_kind_check CHECK (kind IN ('note', 'blocker', 'blocker_resolved')),
  ADD CONSTRAINT simple_updates_blocker_length CHECK (kind <> 'blocker' OR length(body) <= 4000);

CREATE TABLE simple_item_stars (
  item_id text NOT NULL REFERENCES simple_items(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, person_id)
);
CREATE INDEX simple_item_stars_person_idx ON simple_item_stars(person_id, item_id);
