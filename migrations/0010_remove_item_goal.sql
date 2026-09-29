INSERT INTO simple_workstream_goals(workstream_id, goal_id)
SELECT DISTINCT item.workstream_id, item.goal_id
FROM simple_items AS item
WHERE item.goal_id IS NOT NULL
ON CONFLICT (workstream_id, goal_id) DO NOTHING;

-- Goal filters and free-text search now include inherited workstream goals.
UPDATE simple_work_assessment_preferences
SET enabled = false
WHERE enabled
  AND (
    NULLIF(scope->>'goalId', '') IS NOT NULL
    OR NULLIF(BTRIM(scope->>'search'), '') IS NOT NULL
  );
DROP INDEX IF EXISTS simple_items_goal_idx;
ALTER TABLE simple_items DROP COLUMN goal_id;
