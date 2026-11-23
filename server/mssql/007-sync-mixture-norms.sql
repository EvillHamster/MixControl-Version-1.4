-- Keep every linked measurement aligned with the mixture's current limits.
-- The measurement trigger handles report invalidation and live UI notifications.
DECLARE @lockResult int;
EXEC @lockResult=sys.sp_getapplock
 @Resource=N'mixcontrol:workflow',@LockMode='Exclusive',
 @LockOwner='Transaction',@LockTimeout=15000;
IF @lockResult<0 THROW 51000,N'Не удалось заблокировать обновление нормативов',1;
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

 -- A limits-only update must not recreate corrective actions deleted by KEYUSER.
 IF (UPDATE(t_min) OR UPDATE(t_max)) AND NOT (
   UPDATE(date) OR UPDATE(sup) OR UPDATE(mixture_id) OR UPDATE(mixture_name) OR
   UPDATE(actual) OR UPDATE(equipment) OR UPDATE(actual_min) OR UPDATE(actual_max) OR
   UPDATE(legacy_pending) OR UPDATE(created_by)
 )
 BEGIN
   UPDATE dbo.change_revision SET revision=revision+1 WHERE topic='measurements';
   RETURN;
 END;
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
GO
CREATE OR ALTER TRIGGER dbo.mixtures_sync_measurement_norms ON dbo.mixtures AFTER UPDATE AS
BEGIN
 SET NOCOUNT ON;
 IF TRY_CONVERT(bit,SESSION_CONTEXT(N'restoring'))=1 RETURN;
 IF NOT (UPDATE(t_min) OR UPDATE(t_max)) RETURN;

 DECLARE @changed TABLE(
   id uniqueidentifier PRIMARY KEY,mixture_id uniqueidentifier,sup nvarchar(80),
   old_min float,old_max float,old_status varchar(3),old_version int,
   new_min float,new_max float,new_status varchar(3),new_version int
 );
 UPDATE m SET
   t_min=i.t_min,t_max=i.t_max,version=m.version+1,updated_at=SYSUTCDATETIME()
 OUTPUT inserted.id,inserted.mixture_id,inserted.sup,
        deleted.t_min,deleted.t_max,deleted.status,deleted.version,
        inserted.t_min,inserted.t_max,inserted.status,inserted.version
 INTO @changed
 FROM dbo.measurements m JOIN inserted i ON i.id=m.mixture_id
 WHERE m.t_min<>i.t_min OR m.t_max<>i.t_max;

 INSERT dbo.audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,after_data,details)
 SELECT TRY_CONVERT(uniqueidentifier,SESSION_CONTEXT(N'actor_id')),
        COALESCE(CONVERT(nvarchar(64),SESSION_CONTEXT(N'actor_login')),N'system'),
        N'record.norms_updated',N'measurements',LOWER(CONVERT(varchar(36),c.id)),c.sup,
        (SELECT c.old_min AS tMin,c.old_max AS tMax,c.old_status AS status,c.old_version AS version
         FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES),
        (SELECT c.new_min AS tMin,c.new_max AS tMax,c.new_status AS status,c.new_version AS version
         FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES),
        (SELECT LOWER(CONVERT(varchar(36),c.mixture_id)) AS mixtureId,N'mixture_limits_changed' AS reason
         FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)
 FROM @changed c;
END;
GO
-- Reconcile older snapshots once; the same trigger audits and publishes changes.
UPDATE m SET t_min=m.t_min
FROM dbo.mixtures m
WHERE EXISTS(
 SELECT 1 FROM dbo.measurements r
 WHERE r.mixture_id=m.id AND (r.t_min<>m.t_min OR r.t_max<>m.t_max)
);
