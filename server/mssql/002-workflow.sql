CREATE TRIGGER dbo.users_change ON dbo.users AFTER INSERT, UPDATE, DELETE AS
BEGIN
 SET NOCOUNT ON;
 IF EXISTS(SELECT 1 FROM inserted) OR EXISTS(SELECT 1 FROM deleted)
  UPDATE dbo.change_revision SET revision=revision+1 WHERE topic='users';
END;
GO
CREATE TRIGGER dbo.mixtures_change ON dbo.mixtures AFTER INSERT, UPDATE, DELETE AS
BEGIN
 SET NOCOUNT ON;
 IF EXISTS(SELECT 1 FROM inserted) OR EXISTS(SELECT 1 FROM deleted)
  UPDATE dbo.change_revision SET revision=revision+1 WHERE topic='mixtures';
END;
GO
CREATE TRIGGER dbo.daily_reports_change ON dbo.daily_reports AFTER INSERT, UPDATE, DELETE AS
BEGIN
 SET NOCOUNT ON;
 IF EXISTS(SELECT 1 FROM inserted) OR EXISTS(SELECT 1 FROM deleted)
  UPDATE dbo.change_revision SET revision=revision+1 WHERE topic='reports';
END;
GO
CREATE TRIGGER dbo.corrective_actions_change ON dbo.corrective_actions AFTER INSERT, UPDATE, DELETE AS
BEGIN
 SET NOCOUNT ON;
 IF NOT EXISTS(SELECT 1 FROM inserted) AND NOT EXISTS(SELECT 1 FROM deleted) RETURN;

 -- SQL Server performs the FK cascade before firing this AFTER trigger.
 INSERT dbo.audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,details)
 SELECT TRY_CONVERT(uniqueidentifier,SESSION_CONTEXT(N'actor_id')),
        COALESCE(CONVERT(nvarchar(64),SESSION_CONTEXT(N'actor_login')),N'system'),
        'correction.source_deleted','corrective_actions',LOWER(CONVERT(varchar(36),d.id)),d.sup,
        (SELECT d.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES),
        (SELECT N'Source measurement deleted' AS reason,LOWER(CONVERT(varchar(36),d.measurement_key)) AS measurementId,
          LOWER(CONVERT(varchar(36),d.id)) AS correctionId,COALESCE(CONVERT(nvarchar(120),SESSION_CONTEXT(N'actor_name')),N'Система') AS actorName
          FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)
 FROM deleted d WHERE NOT EXISTS(SELECT 1 FROM dbo.measurements m WHERE m.id=d.measurement_key);
 UPDATE dbo.change_revision SET revision=revision+1 WHERE topic='corrections';
END;
GO
CREATE TRIGGER dbo.measurements_workflow ON dbo.measurements AFTER INSERT, UPDATE, DELETE AS
BEGIN
 SET NOCOUNT ON;
 IF NOT EXISTS(SELECT 1 FROM inserted) AND NOT EXISTS(SELECT 1 FROM deleted) RETURN;
 IF TRY_CONVERT(bit,SESSION_CONTEXT(N'restoring'))=1 RETURN;

 DECLARE @actor uniqueidentifier=TRY_CONVERT(uniqueidentifier,SESSION_CONTEXT(N'actor_id'));
 DECLARE @login nvarchar(64)=COALESCE(CONVERT(nvarchar(64),SESSION_CONTEXT(N'actor_login')),N'system');
 DECLARE @name nvarchar(120)=COALESCE(CONVERT(nvarchar(120),SESSION_CONTEXT(N'actor_name')),N'Система');

 INSERT dbo.report_dirty_days(date)
 SELECT s.date FROM (SELECT date FROM inserted UNION SELECT date FROM deleted) s
 WHERE NOT EXISTS(SELECT 1 FROM dbo.report_dirty_days q WITH (UPDLOCK,HOLDLOCK) WHERE q.date=s.date);

 DECLARE @changes TABLE(id uniqueidentifier PRIMARY KEY, kind varchar(30), before_data nvarchar(max), after_data nvarchar(max));
 INSERT @changes
 SELECT c.id,
   CASE WHEN i.delta<=3 AND EXISTS(SELECT i.actual,i.equipment EXCEPT SELECT c.actual,c.equipment) THEN 'auto_deleted' ELSE 'measurement_changed' END,
   (SELECT c.* FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES),
   (SELECT i.date,i.sup,i.mixture_name AS mixtureName,i.actual,i.equipment,i.delta FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES)
 FROM inserted i JOIN dbo.corrective_actions c WITH (UPDLOCK) ON c.measurement_key=i.id
 WHERE EXISTS(SELECT i.date,i.sup COLLATE Latin1_General_100_BIN2,i.mixture_name COLLATE Latin1_General_100_BIN2,i.actual,i.equipment,CONVERT(float,i.delta)
              EXCEPT SELECT c.date,c.sup COLLATE Latin1_General_100_BIN2,c.mixture_name COLLATE Latin1_General_100_BIN2,c.actual,c.equipment,c.delta);

 INSERT dbo.audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,after_data,details)
 SELECT @actor,@login,'correction.auto_deleted','corrective_actions',LOWER(CONVERT(varchar(36),c.id)),i.sup,k.before_data,k.after_data,
     (SELECT N'Temperatures corrected: delta <= 3 C' AS reason,LOWER(CONVERT(varchar(36),i.id)) AS measurementId,
      LOWER(CONVERT(varchar(36),c.id)) AS correctionId,@name AS actorName,3 AS threshold FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)
 FROM @changes k JOIN dbo.corrective_actions c ON c.id=k.id JOIN inserted i ON i.id=c.measurement_key WHERE k.kind='auto_deleted';
 DELETE c FROM dbo.corrective_actions c JOIN @changes k ON k.id=c.id WHERE k.kind='auto_deleted';

 UPDATE c SET date=i.date,sup=i.sup,mixture_name=i.mixture_name,actual=i.actual,equipment=i.equipment,delta=i.delta,
              version=c.version+1,updated_at=SYSUTCDATETIME()
 FROM dbo.corrective_actions c JOIN @changes k ON k.id=c.id JOIN inserted i ON i.id=c.measurement_key WHERE k.kind='measurement_changed';

 UPDATE k SET after_data=(SELECT c.* FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES)
 FROM @changes k JOIN dbo.corrective_actions c ON c.id=k.id WHERE k.kind='measurement_changed';

 INSERT dbo.corrective_actions(measurement_key,measurement_id,date,sup,mixture_name,actual,equipment,delta,initial_data)
 OUTPUT inserted.id,'detected',NULL,inserted.initial_data INTO @changes
 SELECT i.id,i.id,i.date,i.sup,i.mixture_name,i.actual,i.equipment,i.delta,
   (SELECT i.date,i.sup,i.mixture_name AS mixtureName,i.actual,i.equipment,i.delta FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES)
 FROM inserted i WHERE i.delta>3 AND NOT EXISTS(SELECT 1 FROM dbo.corrective_actions c WITH (UPDLOCK,HOLDLOCK) WHERE c.measurement_key=i.id);

 INSERT dbo.correction_events(correction_id,kind,actor_id,actor_login,actor_name,before_data,after_data)
 SELECT id,kind,@actor,@login,@name,before_data,after_data FROM @changes WHERE kind<>'auto_deleted';
 INSERT dbo.audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,after_data)
 SELECT @actor,@login,'correction.'+k.kind,'corrective_actions',LOWER(CONVERT(varchar(36),k.id)),c.sup,k.before_data,k.after_data
 FROM @changes k JOIN dbo.corrective_actions c ON c.id=k.id WHERE k.kind<>'auto_deleted';

 UPDATE dbo.change_revision SET revision=revision+1 WHERE topic='measurements';
END;
