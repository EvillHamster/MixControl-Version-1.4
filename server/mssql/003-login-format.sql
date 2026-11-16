-- Keep this check in sync with loginSchema in server/auth.ts.
ALTER TABLE dbo.users DROP CONSTRAINT users_login_format;
ALTER TABLE dbo.users WITH CHECK ADD CONSTRAINT users_login_format CHECK (
  login IS NULL OR (
    LEN(login) BETWEEN 3 AND 64
    AND login NOT LIKE N'%[^-a-z0-9._]%'
    AND DATALENGTH(login)=2*LEN(login)
  )
);
