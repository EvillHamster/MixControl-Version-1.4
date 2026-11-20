-- Measurement ID stays unique. SUP identifies a production batch, not an attempt.
ALTER TABLE dbo.measurements DROP CONSTRAINT measurements_sup_unique;
CREATE INDEX measurements_sup_idx ON dbo.measurements(sup);
-- Reject previews made under the old SUP-based update rules.
UPDATE dbo.import_jobs SET consumed_at=SYSUTCDATETIME() WHERE kind='records' AND consumed_at IS NULL;
