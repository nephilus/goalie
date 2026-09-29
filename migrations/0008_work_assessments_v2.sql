DELETE FROM simple_work_assessments
WHERE record->>'version' = 'work-assessment-v1';
