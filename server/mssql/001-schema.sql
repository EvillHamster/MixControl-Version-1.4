CREATE TABLE dbo.users (
 id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 login nvarchar(64) COLLATE Latin1_General_100_BIN2 NULL,
 name nvarchar(120) NOT NULL CHECK(LEN(LTRIM(RTRIM(name)))>0),
 password_hash nvarchar(256) NULL,
 role nvarchar(16) NOT NULL CHECK(role IN ('ADMIN','KEYUSER','EMPLOYEE')),
 active bit NOT NULL DEFAULT 1,
 version int NOT NULL DEFAULT 1,
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 deleted_at datetime2(3) NULL,
 CONSTRAINT users_login_format CHECK(login IS NULL OR (LEN(login) BETWEEN 3 AND 64 AND login NOT LIKE N'%[^a-z0-9._-]%' AND DATALENGTH(login)=2*LEN(login))),
 CONSTRAINT users_credentials_lifecycle CHECK((deleted_at IS NULL AND login IS NOT NULL AND password_hash IS NOT NULL) OR (deleted_at IS NOT NULL AND login IS NULL AND password_hash IS NULL AND active=0))
);
CREATE UNIQUE INDEX users_login_unique ON dbo.users(login) WHERE login IS NOT NULL;
CREATE UNIQUE INDEX users_single_keyuser ON dbo.users(role) WHERE role='KEYUSER';
CREATE TABLE dbo.sessions (
 token_hash char(64) PRIMARY KEY,
 user_id uniqueidentifier NOT NULL REFERENCES dbo.users(id) ON DELETE CASCADE,
 expires_at datetime2(3) NOT NULL,
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX sessions_user_idx ON dbo.sessions(user_id);
CREATE INDEX sessions_expiry_idx ON dbo.sessions(expires_at);

CREATE TABLE dbo.mixtures (
 id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 name nvarchar(120) NOT NULL CHECK(LEN(LTRIM(RTRIM(name)))>0),
 t_min float NOT NULL CHECK(t_min BETWEEN -273.15 AND 10000),
 t_max float NOT NULL,
 archived bit NOT NULL DEFAULT 0,
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 CONSTRAINT mixtures_temperature_range CHECK(t_max BETWEEN t_min AND 10000)
);
CREATE TABLE dbo.measurements (
 id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 date date NOT NULL DEFAULT CONVERT(date, SYSDATETIMEOFFSET() AT TIME ZONE 'Russian Standard Time'),
 sup nvarchar(80) COLLATE Latin1_General_100_BIN2 NOT NULL CONSTRAINT measurements_sup_unique UNIQUE,
 mixture_id uniqueidentifier NOT NULL REFERENCES dbo.mixtures(id),
 mixture_name nvarchar(120) NOT NULL,
 t_min float NOT NULL CHECK(t_min BETWEEN -273.15 AND 10000),
 t_max float NOT NULL,
 actual_min float NULL CHECK(actual_min BETWEEN -273.15 AND 10000),
 actual_max float NULL CHECK(actual_max BETWEEN -273.15 AND 10000),
 actual float NULL CHECK(actual BETWEEN -273.15 AND 10000),
 equipment float NULL CHECK(equipment BETWEEN -273.15 AND 10000),
 legacy_pending bit NOT NULL DEFAULT 0,
 created_by uniqueidentifier NULL REFERENCES dbo.users(id),
 status AS CONVERT(varchar(3),CASE
   WHEN actual<t_min OR actual>t_max OR equipment<t_min OR equipment>t_max THEN 'NOK'
   WHEN legacy_pending=1 THEN CASE WHEN actual_min IS NULL OR actual_max IS NULL THEN NULL WHEN actual_min>=t_min AND actual_max<=t_max AND actual_min<=actual_max THEN 'OK' ELSE 'NOK' END
   WHEN actual IS NULL OR equipment IS NULL THEN NULL ELSE 'OK' END) PERSISTED,
 delta AS ABS(CONVERT(decimal(28,14),actual)-CONVERT(decimal(28,14),equipment)) PERSISTED,
 version int NOT NULL DEFAULT 1,
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 updated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 CONSTRAINT measurements_temperature_range CHECK(t_max BETWEEN t_min AND 10000),
 CONSTRAINT measurements_sup_seven_digits CHECK(DATALENGTH(sup)=14 AND sup NOT LIKE N'%[^0-9]%')
);
CREATE INDEX measurements_date_idx ON dbo.measurements(date DESC,created_at DESC);
CREATE INDEX measurements_mixture_idx ON dbo.measurements(mixture_id);
CREATE INDEX measurements_author_idx ON dbo.measurements(created_by);
CREATE INDEX measurements_status_idx ON dbo.measurements(status);

CREATE TABLE dbo.audit_log (
 id bigint IDENTITY PRIMARY KEY,
 actor_id uniqueidentifier NULL REFERENCES dbo.users(id),
 actor_login nvarchar(64) NOT NULL,
 action nvarchar(100) NOT NULL,
 entity nvarchar(64) NOT NULL,
 entity_id nvarchar(100) NULL,
 sup nvarchar(80) NULL,
 before_data nvarchar(max) NULL,
 after_data nvarchar(max) NULL,
 details nvarchar(max) NOT NULL DEFAULT N'{}',
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX audit_log_created_idx ON dbo.audit_log(created_at DESC,id DESC);
CREATE INDEX audit_log_sup_idx ON dbo.audit_log(sup);
CREATE TABLE dbo.import_jobs (
 id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 actor_id uniqueidentifier NOT NULL REFERENCES dbo.users(id),
 kind nvarchar(16) NOT NULL CHECK(kind IN ('records','mixtures')),
 payload nvarchar(max) NOT NULL CHECK(ISJSON(payload)=1),
 expires_at datetime2(3) NOT NULL DEFAULT DATEADD(minute,30,SYSUTCDATETIME()),
 consumed_at datetime2(3) NULL
);
CREATE INDEX import_jobs_expiry_idx ON dbo.import_jobs(expires_at);

CREATE TABLE dbo.corrective_actions (
 id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 measurement_key uniqueidentifier NOT NULL UNIQUE REFERENCES dbo.measurements(id) ON DELETE CASCADE,
 measurement_id uniqueidentifier NULL,
 date date NOT NULL,
 sup nvarchar(80) NOT NULL,
 mixture_name nvarchar(120) NOT NULL,
 actual float NULL, equipment float NULL, delta float NULL,
 initial_data nvarchar(max) NOT NULL CHECK(ISJSON(initial_data)=1),
 source_deleted bit NOT NULL DEFAULT 0,
 status nvarchar(16) NOT NULL DEFAULT 'NOT_STARTED' CHECK(status IN ('NOT_STARTED','IN_PROGRESS','DONE')),
 responsible_id uniqueidentifier NULL REFERENCES dbo.users(id),
 work_done nvarchar(max) NOT NULL DEFAULT N'' CHECK(DATALENGTH(work_done)<=20000),
 detected_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 completed_at datetime2(3) NULL,
 updated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 version int NOT NULL DEFAULT 1,
 CONSTRAINT corrective_measurement_consistent CHECK(measurement_id IS NOT NULL AND measurement_id=measurement_key AND source_deleted=0)
);
CREATE INDEX corrections_page_idx ON dbo.corrective_actions(status,date DESC,detected_at DESC,id);
CREATE INDEX corrective_date_idx ON dbo.corrective_actions(date DESC,id);
CREATE INDEX corrective_responsible_idx ON dbo.corrective_actions(responsible_id,date DESC);
CREATE INDEX corrective_sup_idx ON dbo.corrective_actions(sup);
CREATE TABLE dbo.correction_events (
 id bigint IDENTITY PRIMARY KEY,
 correction_id uniqueidentifier NOT NULL REFERENCES dbo.corrective_actions(id) ON DELETE CASCADE,
 kind nvarchar(64) NOT NULL,
 actor_id uniqueidentifier NULL REFERENCES dbo.users(id),
 actor_login nvarchar(64) NOT NULL,
 actor_name nvarchar(120) NOT NULL,
 before_data nvarchar(max) NULL,
 after_data nvarchar(max) NULL,
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX correction_events_parent_idx ON dbo.correction_events(correction_id,id DESC);
CREATE TABLE dbo.correction_comments (
 id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 correction_id uniqueidentifier NOT NULL REFERENCES dbo.corrective_actions(id) ON DELETE CASCADE,
 original_correction_id uniqueidentifier NOT NULL,
 author_id uniqueidentifier NOT NULL REFERENCES dbo.users(id),
 author_name nvarchar(120) NOT NULL,
 author_login nvarchar(64) NOT NULL,
 text nvarchar(max) NOT NULL CHECK(LEN(LTRIM(RTRIM(text))) BETWEEN 1 AND 5000),
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX correction_comments_parent_idx ON dbo.correction_comments(correction_id,created_at DESC,id);

CREATE TABLE dbo.daily_reports (
 date date PRIMARY KEY, total int NOT NULL, ok int NOT NULL, nok int NOT NULL, pending int NOT NULL,
 nok_percent decimal(5,2) NOT NULL, nok_rows nvarchar(max) NOT NULL DEFAULT N'[]' CHECK(ISJSON(nok_rows)=1),
 version int NOT NULL DEFAULT 1,
 generated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 updated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.report_dirty_days(date date PRIMARY KEY);
CREATE TABLE dbo.report_scheduler(id int PRIMARY KEY CHECK(id=1),last_day date NULL);
INSERT INTO dbo.report_scheduler(id) VALUES(1);
CREATE TABLE dbo.change_revision(topic varchar(24) PRIMARY KEY, revision bigint NOT NULL DEFAULT 0);
INSERT INTO dbo.change_revision(topic) VALUES('users'),('measurements'),('mixtures'),('corrections'),('reports');
