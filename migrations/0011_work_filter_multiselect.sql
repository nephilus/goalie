UPDATE simple_work_assessment_preferences
SET scope = (scope - ARRAY['workstreamId', 'goalId', 'assigneeId', 'status', 'tagId']) || jsonb_build_object(
  'workstreamIds', CASE WHEN scope->>'workstreamId' = '' THEN '[]'::jsonb ELSE jsonb_build_array(scope->'workstreamId') END,
  'goalIds', CASE WHEN scope->>'goalId' = '' THEN '[]'::jsonb ELSE jsonb_build_array(scope->'goalId') END,
  'assigneeIds', CASE WHEN scope->>'assigneeId' = '' THEN '[]'::jsonb ELSE jsonb_build_array(scope->'assigneeId') END,
  'statuses', CASE WHEN scope->>'status' = '' THEN '[]'::jsonb ELSE jsonb_build_array(scope->'status') END,
  'tagIds', CASE WHEN scope->>'tagId' = '' THEN '[]'::jsonb ELSE jsonb_build_array(scope->'tagId') END
)
WHERE scope IS NOT NULL
  AND jsonb_typeof(scope) = 'object'
  AND scope ?& ARRAY['workstreamId', 'goalId', 'assigneeId', 'status', 'tagId']
  AND NOT (scope ?| ARRAY['workstreamIds', 'goalIds', 'assigneeIds', 'statuses', 'tagIds']);
