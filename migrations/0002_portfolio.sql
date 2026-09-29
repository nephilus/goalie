CREATE TABLE outcomes (
  id text PRIMARY KEY,
  workstream_id text NOT NULL REFERENCES workstreams(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  owner_id text REFERENCES people(id) ON DELETE SET NULL,
  priority text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status text NOT NULL CHECK (status IN ('planned', 'active', 'achieved', 'cancelled')),
  window_json jsonb NOT NULL,
  item_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outcomes_workstream_idx ON outcomes(workstream_id);
CREATE INDEX outcomes_owner_idx ON outcomes(owner_id);

CREATE TABLE capabilities (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE capability_signals (
  id text PRIMARY KEY,
  outcome_id text NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  capability_id text NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('requires', 'produces')),
  scope text NOT NULL DEFAULT '',
  window_json jsonb NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX capability_signals_outcome_idx ON capability_signals(outcome_id);
CREATE INDEX capability_signals_capability_idx ON capability_signals(capability_id);

CREATE TABLE coordination_opportunities (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('reuse', 'shared_prerequisite', 'resource_contention', 'potential_duplication', 'timing_mismatch', 'staged_convergence')),
  description text NOT NULL DEFAULT '',
  outcome_ids_json jsonb NOT NULL,
  capability_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  window_json jsonb NOT NULL,
  decision_by text,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  options_json jsonb NOT NULL,
  questions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  origin text NOT NULL CHECK (origin IN ('manual', 'ai')),
  status text NOT NULL CHECK (status IN ('open', 'dismissed', 'decided')),
  dismissal_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coordination_opportunities_status_idx ON coordination_opportunities(status);

CREATE TABLE portfolio_decisions (
  id text PRIMARY KEY,
  opportunity_id text NOT NULL REFERENCES coordination_opportunities(id) ON DELETE RESTRICT,
  owner_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  rationale text NOT NULL,
  review_date text,
  review_milestone_id text REFERENCES items(id) ON DELETE RESTRICT,
  review_note text NOT NULL DEFAULT '',
  transition_window_json jsonb NOT NULL,
  option_json jsonb NOT NULL,
  opportunity_title text NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome_ids_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'superseded')),
  decided_by text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portfolio_decisions_opportunity_idx ON portfolio_decisions(opportunity_id);
CREATE INDEX portfolio_decisions_status_idx ON portfolio_decisions(status);

CREATE TABLE dependency_commitments (
  id text PRIMARY KEY,
  decision_id text NOT NULL REFERENCES portfolio_decisions(id) ON DELETE RESTRICT,
  predecessor_id text NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  successor_id text NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  activation text NOT NULL CHECK (activation IN ('now', 'after_date', 'after_milestone')),
  activate_on text,
  milestone_id text REFERENCES items(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('planned', 'active', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CHECK (predecessor_id <> successor_id),
  CHECK ((activation = 'now' AND activate_on IS NULL AND milestone_id IS NULL) OR (activation = 'after_date' AND activate_on IS NOT NULL AND milestone_id IS NULL) OR (activation = 'after_milestone' AND activate_on IS NULL AND milestone_id IS NOT NULL))
);
CREATE UNIQUE INDEX dependency_commitments_decision_edge_unique ON dependency_commitments(decision_id, predecessor_id, successor_id);
CREATE INDEX dependency_commitments_edge_idx ON dependency_commitments(predecessor_id, successor_id);

