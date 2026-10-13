-- 0012 generated this name for its second table-level CHECK. Keep the first
-- CHECK (exactly one ADR/update source), kind validation, FKs and dedupe intact.
-- Do not rewrite 0012: applied migration checksums must remain valid.
ALTER TABLE simple_notifications DROP CONSTRAINT simple_notifications_check1;
