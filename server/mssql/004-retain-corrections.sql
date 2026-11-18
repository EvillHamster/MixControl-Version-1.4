-- Keep the original measurement_key as immutable history; only the live link is nullable.
DECLARE @drop nvarchar(max)=N'';
SELECT @drop=@drop+N'ALTER TABLE dbo.corrective_actions DROP CONSTRAINT '+QUOTENAME(f.name)+N';'
FROM sys.foreign_keys f
WHERE f.parent_object_id=OBJECT_ID(N'dbo.corrective_actions')
  AND f.referenced_object_id=OBJECT_ID(N'dbo.measurements');
IF LEN(@drop)>0 EXEC sys.sp_executesql @drop;

ALTER TABLE dbo.corrective_actions DROP CONSTRAINT corrective_measurement_consistent;
ALTER TABLE dbo.corrective_actions WITH CHECK ADD CONSTRAINT corrective_measurement_consistent
 CHECK(measurement_id IS NULL OR (measurement_id=measurement_key AND source_deleted=0));
ALTER TABLE dbo.corrective_actions WITH CHECK ADD CONSTRAINT corrective_measurement_live
 FOREIGN KEY(measurement_id) REFERENCES dbo.measurements(id) ON DELETE SET NULL;
GO
CREATE OR ALTER TRIGGER dbo.corrective_actions_change ON dbo.corrective_actions AFTER INSERT, UPDATE, DELETE AS
BEGIN
 SET NOCOUNT ON;
 IF NOT EXISTS(SELECT 1 FROM inserted) AND NOT EXISTS(SELECT 1 FROM deleted) RETURN;

 IF EXISTS(SELECT 1 FROM deleted d WHERE NOT EXISTS(SELECT 1 FROM inserted i WHERE i.id=d.id))
 BEGIN
   IF NOT EXISTS(SELECT 1 FROM dbo.users
     WHERE id=TRY_CONVERT(uniqueidentifier,SESSION_CONTEXT(N'actor_id'))
       AND role='KEYUSER' AND active=1 AND deleted_at IS NULL)
     THROW 51001,N'Удалять корректировки может только KEYUSER',1;

   INSERT dbo.audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,details)
   SELECT TRY_CONVERT(uniqueidentifier,SESSION_CONTEXT(N'actor_id')),
     COALESCE(CONVERT(nvarchar(64),SESSION_CONTEXT(N'actor_login')),N'system'),
     'correction.deleted','corrective_actions',LOWER(CONVERT(varchar(36),d.id)),d.sup,
     (SELECT d.* FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES),
     (SELECT N'KEYUSER explicitly deleted correction' AS reason FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)
   FROM deleted d WHERE NOT EXISTS(SELECT 1 FROM inserted i WHERE i.id=d.id);
 END;
 UPDATE dbo.change_revision SET revision=revision+1 WHERE topic='corrections';
END;
GO
CREATE OR ALTER TRIGGER dbo.measurements_workflow ON dbo.measurements AFTER INSERT, UPDATE, DELETE AS
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
   'measurement_changed',
   (SELECT c.* FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES),
   (SELECT i.date,i.sup,i.mixture_name AS mixtureName,i.actual,i.equipment,i.delta FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES)
 FROM inserted i JOIN dbo.corrective_actions c WITH (UPDLOCK) ON c.measurement_key=i.id
 WHERE EXISTS(SELECT i.date,i.sup COLLATE Latin1_General_100_BIN2,i.mixture_name COLLATE Latin1_General_100_BIN2,i.actual,i.equipment,CONVERT(float,i.delta)
              EXCEPT SELECT c.date,c.sup COLLATE Latin1_General_100_BIN2,c.mixture_name COLLATE Latin1_General_100_BIN2,c.actual,c.equipment,c.delta);

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
 SELECT id,kind,@actor,@login,@name,before_data,after_data FROM @changes;
 INSERT dbo.audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,after_data)
 SELECT @actor,@login,'correction.'+k.kind,'corrective_actions',LOWER(CONVERT(varchar(36),k.id)),c.sup,k.before_data,k.after_data
 FROM @changes k JOIN dbo.corrective_actions c ON c.id=k.id;

 DECLARE @removed TABLE(id uniqueidentifier PRIMARY KEY,before_data nvarchar(max));
 INSERT @removed
 SELECT c.id,(SELECT c.* FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES)
 FROM dbo.corrective_actions c WITH (UPDLOCK)
 JOIN deleted d ON d.id=c.measurement_key
 WHERE NOT EXISTS(SELECT 1 FROM inserted i WHERE i.id=d.id);

 UPDATE c SET measurement_id=NULL,source_deleted=1,version=c.version+1,updated_at=SYSUTCDATETIME()
 FROM dbo.corrective_actions c JOIN @removed r ON r.id=c.id;

 INSERT dbo.correction_events(correction_id,kind,actor_id,actor_login,actor_name,before_data,after_data)
 SELECT c.id,'measurement_deleted',@actor,@login,@name,r.before_data,
        (SELECT c.* FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES)
 FROM dbo.corrective_actions c JOIN @removed r ON r.id=c.id;

 INSERT dbo.audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,after_data)
 SELECT @actor,@login,'correction.source_deleted','corrective_actions',LOWER(CONVERT(varchar(36),c.id)),c.sup,r.before_data,
        (SELECT c.* FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES)
 FROM dbo.corrective_actions c JOIN @removed r ON r.id=c.id;

 UPDATE dbo.change_revision SET revision=revision+1 WHERE topic='measurements';
END;
