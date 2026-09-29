CREATE TABLE simple_workspace (
  id integer PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE simple_goals (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  target_date text CHECK (target_date IS NULL OR target_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE simple_workstreams (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  lead_id text REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX simple_workstreams_lead_idx ON simple_workstreams(lead_id);

CREATE TABLE simple_workstream_goals (
  workstream_id text NOT NULL REFERENCES simple_workstreams(id) ON DELETE CASCADE,
  goal_id text NOT NULL REFERENCES simple_goals(id) ON DELETE CASCADE,
  PRIMARY KEY (workstream_id, goal_id)
);
CREATE INDEX simple_workstream_goals_goal_idx ON simple_workstream_goals(goal_id);

CREATE TABLE simple_tags (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  workstream_id text REFERENCES simple_workstreams(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX simple_tags_name_stream_unique ON simple_tags (lower(name), COALESCE(workstream_id, ''));
CREATE INDEX simple_tags_workstream_idx ON simple_tags(workstream_id);

CREATE TABLE simple_items (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
  workstream_id text NOT NULL REFERENCES simple_workstreams(id) ON DELETE RESTRICT,
  goal_id text REFERENCES simple_goals(id) ON DELETE SET NULL,
  parent_id text REFERENCES simple_items(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('todo', 'doing', 'done')),
  assignee_id text REFERENCES people(id) ON DELETE SET NULL,
  due_date text CHECK (due_date IS NULL OR due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  blocker text NOT NULL DEFAULT '' CHECK (length(blocker) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX simple_items_workstream_idx ON simple_items(workstream_id);
CREATE INDEX simple_items_goal_idx ON simple_items(goal_id);
CREATE INDEX simple_items_parent_idx ON simple_items(parent_id);
CREATE INDEX simple_items_assignee_idx ON simple_items(assignee_id);

CREATE TABLE simple_item_tags (
  item_id text NOT NULL REFERENCES simple_items(id) ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES simple_tags(id) ON DELETE RESTRICT,
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX simple_item_tags_tag_idx ON simple_item_tags(tag_id);

CREATE TABLE simple_updates (
  id text PRIMARY KEY,
  item_id text NOT NULL REFERENCES simple_items(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX simple_updates_item_idx ON simple_updates(item_id);

CREATE TABLE simple_changes (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  action text NOT NULL,
  entity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX simple_changes_created_idx ON simple_changes(created_at, id);
CREATE INDEX simple_changes_entity_idx ON simple_changes(entity_id);

INSERT INTO simple_workspace(id, revision, demo) VALUES (1, 0, false);
