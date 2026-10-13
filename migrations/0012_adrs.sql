CREATE TABLE simple_adrs (
  id text PRIMARY KEY,
  item_id text NOT NULL REFERENCES simple_items(id) ON DELETE RESTRICT,
  creator_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  requester jsonb NOT NULL,
  approver jsonb NOT NULL,
  requester_person_id text GENERATED ALWAYS AS (CASE WHEN requester->>'kind' = 'person' THEN requester->>'personId' END) STORED REFERENCES people(id) ON DELETE RESTRICT,
  approver_person_id text GENERATED ALWAYS AS (CASE WHEN approver->>'kind' = 'person' THEN approver->>'personId' END) STORED REFERENCES people(id) ON DELETE RESTRICT,
  context text NOT NULL CHECK (length(btrim(context)) BETWEEN 1 AND 20000),
  concern text NOT NULL CHECK (length(btrim(concern)) BETWEEN 1 AND 20000),
  decision text NOT NULL CHECK (length(btrim(decision)) BETWEEN 1 AND 20000),
  alternatives text NOT NULL CHECK (length(btrim(alternatives)) BETWEEN 1 AND 20000),
  consequences text NOT NULL CHECK (length(btrim(consequences)) BETWEEN 1 AND 20000),
  downsides text NOT NULL CHECK (length(btrim(downsides)) BETWEEN 1 AND 20000),
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 20000),
  document_url text CHECK (document_url IS NULL OR document_url ~* '^https?://'),
  mentioned_person_ids text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'changes_requested')),
  approval jsonb,
  revision bigint NOT NULL CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'approved') = (approval IS NOT NULL)),
  CHECK (coalesce(jsonb_typeof(requester) = 'object' AND (
    (requester->>'kind' = 'person' AND jsonb_typeof(requester->'personId') = 'string' AND length(btrim(requester->>'personId')) BETWEEN 1 AND 100 AND requester - 'kind' - 'personId' = '{}'::jsonb)
    OR (requester->>'kind' = 'name' AND jsonb_typeof(requester->'name') = 'string' AND length(btrim(requester->>'name')) BETWEEN 1 AND 100 AND requester - 'kind' - 'name' = '{}'::jsonb)
  ), false)),
  CHECK (coalesce(jsonb_typeof(approver) = 'object' AND (
    (approver->>'kind' = 'person' AND jsonb_typeof(approver->'personId') = 'string' AND length(btrim(approver->>'personId')) BETWEEN 1 AND 100 AND approver - 'kind' - 'personId' = '{}'::jsonb)
    OR (approver->>'kind' = 'name' AND jsonb_typeof(approver->'name') = 'string' AND length(btrim(approver->>'name')) BETWEEN 1 AND 100 AND approver - 'kind' - 'name' = '{}'::jsonb)
  ), false))
);
CREATE INDEX simple_adrs_item ON simple_adrs(item_id, updated_at DESC, id);
CREATE INDEX simple_adrs_status ON simple_adrs(status, updated_at DESC, id);

-- Complete immutable snapshots preserve superseded approvals and identity selections.
CREATE TABLE simple_adr_history (
  id text PRIMARY KEY,
  adr_id text NOT NULL REFERENCES simple_adrs(id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  action text NOT NULL,
  comment text,
  revision bigint NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adr_id, revision)
);
CREATE INDEX simple_adr_history_page ON simple_adr_history(adr_id, revision DESC, id);

-- Keep relational references even after the live ADR selects different people.
-- An older application must not be able to delete identities retained by an audit snapshot.
CREATE TABLE simple_adr_history_people (
  history_id text NOT NULL REFERENCES simple_adr_history(id) ON DELETE RESTRICT,
  person_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  PRIMARY KEY (history_id, person_id)
);
CREATE INDEX simple_adr_history_people_person ON simple_adr_history_people(person_id);

CREATE TABLE simple_notifications (
  id text PRIMARY KEY,
  recipient_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('approval_requested', 'approval_result', 'mention')),
  item_id text NOT NULL REFERENCES simple_items(id) ON DELETE CASCADE,
  adr_id text REFERENCES simple_adrs(id) ON DELETE CASCADE,
  update_id text REFERENCES simple_updates(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL UNIQUE,
  read_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((adr_id IS NOT NULL)::int + (update_id IS NOT NULL)::int = 1),
  CHECK (recipient_id <> actor_id)
);
CREATE INDEX simple_notifications_inbox ON simple_notifications(recipient_id, created_at DESC, id) WHERE invalidated_at IS NULL;
CREATE INDEX simple_notifications_adr ON simple_notifications(adr_id) WHERE adr_id IS NOT NULL;
CREATE INDEX simple_notifications_update ON simple_notifications(update_id) WHERE update_id IS NOT NULL;
