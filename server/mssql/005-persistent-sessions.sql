-- Preserve valid sessions; never reactivate an expired session.
DELETE FROM dbo.sessions WHERE expires_at <= SYSUTCDATETIME();
DROP INDEX sessions_expiry_idx ON dbo.sessions;
ALTER TABLE dbo.sessions ALTER COLUMN expires_at datetime2(3) NULL;
UPDATE dbo.sessions SET expires_at=NULL;
CREATE INDEX sessions_expiry_idx ON dbo.sessions(expires_at) WHERE expires_at IS NOT NULL;
