CREATE TABLE workspace (
  id integer PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE people (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  team text NOT NULL DEFAULT '' CHECK (length(team) <= 100),
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX people_email_lower_unique ON people (lower(email));

CREATE TABLE oidc_subject_bindings (
  id text PRIMARY KEY,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject),
  UNIQUE (person_id)
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_person_idx ON sessions(person_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE pending_auth (
  state_hash text PRIMARY KEY,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  return_to text NOT NULL DEFAULT '/',
  issuer text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE workstreams (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  owner_id text REFERENCES people(id) ON DELETE SET NULL,
  priority text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  target_date text,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workstreams_owner_idx ON workstreams(owner_id);

CREATE TABLE items (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  workstream_id text NOT NULL REFERENCES workstreams(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('task', 'milestone')),
  status text NOT NULL CHECK (status IN ('planned', 'in_progress', 'in_review', 'done', 'cancelled')),
  priority text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  owner_id text REFERENCES people(id) ON DELETE SET NULL,
  planned_start text,
  planned_end text,
  target_date text,
  blocker text NOT NULL DEFAULT '',
  external_url text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (planned_start IS NULL OR planned_end IS NULL OR planned_start <= planned_end)
);
CREATE INDEX items_workstream_idx ON items(workstream_id);
CREATE INDEX items_owner_idx ON items(owner_id);

CREATE TABLE assignments (
  item_id text NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, person_id)
);
CREATE INDEX assignments_person_idx ON assignments(person_id);

CREATE TABLE dependencies (
  predecessor_id text NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  successor_id text NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
);
CREATE INDEX dependencies_successor_idx ON dependencies(successor_id);

CREATE TABLE updates (
  id text PRIMARY KEY,
  item_id text NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX updates_item_idx ON updates(item_id);

CREATE TABLE audit_changes (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  action text NOT NULL,
  entity_id text,
  summary text NOT NULL,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_changes_created_idx ON audit_changes(created_at);
CREATE INDEX audit_changes_entity_idx ON audit_changes(entity_id);

INSERT INTO workspace(id, revision, demo) VALUES (1, 0, false);
