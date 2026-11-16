import type { User } from "../shared/domain.js";
import type { DbClient } from "./db.js";
export { transaction } from "./db.js";

export async function audit(
  c: DbClient,
  actor: User | null,
  action: string,
  entity: string,
  id: string | null,
  before: unknown,
  after: unknown,
  details: unknown = {},
  sup: string | null = null,
) {
  await c.query(
    "INSERT INTO dbo.audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,after_data,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      actor?.id ?? null,
      actor?.login ?? "system",
      action,
      entity,
      id,
      sup,
      JSON.stringify(before),
      JSON.stringify(after),
      JSON.stringify(details),
    ],
  );
}

export async function assertActor(c: DbClient, actor: User, manager = false) {
  const user = (
    await c.query(
      "SELECT role FROM dbo.users WITH (HOLDLOCK) WHERE id=$1 AND active=1 AND deleted_at IS NULL",
      [actor.id],
    )
  ).rows[0];
  if (!user || (manager && user.role === "EMPLOYEE"))
    throw Object.assign(new Error("Недостаточно прав. Обновите страницу."), {
      status: 403,
    });
  await setAuditActor(c, actor);
}

export async function setAuditActor(c: DbClient, actor: User) {
  await c.query(
    "EXEC sys.sp_set_session_context @key=N'actor_id', @value=$1; EXEC sys.sp_set_session_context @key=N'actor_login', @value=$2; EXEC sys.sp_set_session_context @key=N'actor_name', @value=$3;",
    [actor.id, actor.login, actor.name],
  );
}
