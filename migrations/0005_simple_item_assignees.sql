CREATE TABLE simple_item_assignees (
  item_id text NOT NULL REFERENCES simple_items(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  PRIMARY KEY (item_id, person_id)
);
CREATE INDEX simple_item_assignees_person_idx ON simple_item_assignees(person_id);

INSERT INTO simple_item_assignees(item_id, person_id)
SELECT id, assignee_id
FROM simple_items
WHERE assignee_id IS NOT NULL;

ALTER TABLE simple_updates ADD COLUMN assignee_ids text[];
