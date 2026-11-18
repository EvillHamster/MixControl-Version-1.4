import sql from "mssql";
import { countsSql, lock, output, pool, type DbClient } from "./db.js";
import { audit, transaction, assertActor } from "./audit.js";
import { z } from "zod";
import {
  databaseIdSchema,
  recordSchema,
  type Measurement,
  type Mixture,
  type User,
} from "../shared/domain.js";
export function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const recordColumns = `id,date,sup,mixture_id AS "mixtureId",mixture_name AS "mixtureName",t_min AS "tMin",t_max AS "tMax",actual,equipment,delta,legacy_pending AS "legacyPending",actual_min AS "actualMin",actual_max AS "actualMax",status,version,created_by AS "createdBy",(SELECT name FROM users WHERE users.id=measurements.created_by) AS "authorName"`;
function filters(query: Record<string, unknown>) {
  const q = z
    .object({
      search: z.string().max(80).optional(),
      mixtureId: databaseIdSchema.optional(),
      line: z.enum(["MB", "FMF"]).optional(),
      status: z.enum(["OK", "NOK", "pending"]).optional(),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
    })
    .parse(query);
  if (q.from && q.to && q.from > q.to)
    fail(400, "Начальная дата не может быть позже конечной");
  const values: unknown[] = [];
  const clauses: string[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    clauses.push(sql.replace("?", `$${values.length}`));
  };
  if (q.search) add("CHARINDEX(?,sup)>0", q.search.trim().toUpperCase());
  if (q.mixtureId) add("mixture_id=?", q.mixtureId);
  if (q.line) {
    const prefix = "LEFT(UPPER(LTRIM(mixture_name)) COLLATE Latin1_General_100_BIN2,2)";
    const mb = prefix + " IN (N'M1',N'M2',N'М1',N'М2')";
    clauses.push(q.line === "MB" ? mb : "NOT (" + mb + ")");
  }
  if (q.status === "pending") clauses.push("status IS NULL");
  else if (q.status) add("status=?", q.status);
  if (q.from) add("date>=CONVERT(date,?,23)", q.from);
  if (q.to) add("date<=CONVERT(date,?,23)", q.to);
  return {
    selection: q,
    where: clauses.length ? " WHERE " + clauses.join(" AND ") : "",
    values,
  };
}
function deletionFilters(query: Record<string, unknown>) {
  const f = filters(query);
  if (
    !f.selection.from &&
    !f.selection.to &&
    !f.selection.mixtureId &&
    !f.selection.line &&
    !f.selection.status &&
    !f.selection.search?.trim()
  )
    fail(400, "Выберите период дат или другой фильтр для удаления");
  return f;
}
async function deletionPreview(c: DbClient, f: ReturnType<typeof filters>) {
  const r = (
    await c.query(
      `SELECT COUNT(*) AS count,LOWER(CONVERT(varchar(32),HASHBYTES('MD5',COALESCE(STRING_AGG(CONVERT(varchar(max),CONCAT(id,':',version)),',') WITHIN GROUP (ORDER BY id),'')),2)) AS fingerprint FROM dbo.measurements${f.where}`,
      f.values,
    )
  ).rows[0];
  return r as { count: number; fingerprint: string };
}
const mixtureNameKey = (name: string) => name.trim().toLocaleLowerCase("ru-RU");
async function duplicateMixtureName(
  c: DbClient,
  name: string,
  exclude?: string,
) {
  const rows = (await c.query("SELECT id,name FROM mixtures")).rows;
  return rows.some(
    (m) => m.id !== exclude && mixtureNameKey(m.name) === mixtureNameKey(name),
  );
}
export const mixtureRepository = {
  async list(includeNorms = true) {
    return (
      await pool.query<Mixture>(
        `SELECT m.id,m.name,${includeNorms ? "m.t_min" : "NULL"} AS "tMin",${includeNorms ? "m.t_max" : "NULL"} AS "tMax",m.archived,${includeNorms ? "(SELECT COUNT(*) FROM measurements r WHERE r.mixture_id=m.id)" : "0"} AS "recordCount" FROM mixtures m ORDER BY m.archived,m.name`,
      )
    ).rows;
  },
  async create(d: { name: string; tMin: number; tMax: number }, actor: User) {
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      await lock(c, "workflow");
      if (await duplicateMixtureName(c, d.name))
        fail(409, "Смесь с таким названием уже существует");
      const row = (
        await c.query(
          output(
            "dbo.mixtures",
            "INSERT INTO dbo.mixtures(name,t_min,t_max) /*output*/ VALUES($1,$2,$3)",
          ),
          [d.name, d.tMin, d.tMax],
        )
      ).rows[0];
      await audit(c, actor, "mixture.create", "mixtures", row.id, null, row);
      return { id: row.id };
    });
  },
  async update(
    id: string,
    d: { name: string; tMin: number; tMax: number; archived?: boolean },
    actor: User,
  ) {
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      await lock(c, "workflow");
      const old = (
        await c.query(
          "SELECT * FROM dbo.mixtures WITH (UPDLOCK,HOLDLOCK) WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!old) fail(404, "Смесь не найдена");
      if (await duplicateMixtureName(c, d.name, id))
        fail(409, "Смесь с таким названием уже существует");
      const row = (
        await c.query(
          output(
            "dbo.mixtures",
            "UPDATE dbo.mixtures SET name=$1,t_min=$2,t_max=$3,archived=$4 /*output*/ WHERE id=$5",
          ),
          [d.name, d.tMin, d.tMax, d.archived ?? false, id],
        )
      ).rows[0];
      await audit(c, actor, "mixture.update", "mixtures", id, old, row);
      return { id };
    });
  },
  async delete(id: string, actor: User) {
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      await lock(c, "workflow");
      const row = (
        await c.query(
          "SELECT * FROM dbo.mixtures WITH (UPDLOCK,HOLDLOCK) WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!row) fail(404, "Смесь не найдена");
      await c.query("DELETE FROM dbo.mixtures WHERE id=$1", [id]);
      await audit(c, actor, "mixture.delete", "mixtures", id, row, null);
    });
  },
};
export const recordRepository = {
  async supAvailable(sup: string, exclude: string | null) {
    return !(
      await pool.query(
        "SELECT 1 FROM measurements WHERE sup=$1 AND (CONVERT(uniqueidentifier,$2) IS NULL OR id<>$2)",
        [sup.trim().toUpperCase(), exclude],
      )
    ).rowCount;
  },
  async list(query: Record<string, unknown>) {
    const { where, values } = filters(query);
    const page = z.coerce.number().int().min(1).default(1).parse(query.page),
      size = z.coerce
        .number()
        .int()
        .min(1)
        .max(15)
        .default(15)
        .parse(query.size);
    const sortMap: Record<string, string> = {
      date: "date",
      sup: "sup",
      mixtureName: "mixture_name",
      tMin: "t_min",
      tMax: "t_max",
      actual: "actual",
      equipment: "equipment",
      status: "status",
    };
    const sort = Object.hasOwn(sortMap, String(query.sort))
        ? sortMap[String(query.sort)]
        : "date",
      dir = query.direction === "asc" ? "ASC" : "DESC";
    return transaction(async (c) => {
      const stats = await c.query(
        `SELECT ${countsSql} FROM dbo.measurements${where}`,
        values,
      );
      const rows = await c.query<Measurement>(
        `SELECT ${recordColumns} FROM dbo.measurements${where} ORDER BY CASE WHEN ${sort} IS NULL THEN 1 ELSE 0 END,${sort} ${dir},created_at DESC,id OFFSET $${values.length + 1} ROWS FETCH NEXT $${values.length + 2} ROWS ONLY`,
        [...values, (page - 1) * size, size],
      );
      return { records: rows.rows, ...stats.rows[0], page, size };
    }, sql.ISOLATION_LEVEL.SERIALIZABLE);
  },
  async export(query: Record<string, unknown>) {
    const { where, values } = filters(query);
    const r = await pool.query<Measurement>(
      `SELECT TOP (100001) ${recordColumns} FROM dbo.measurements${where} ORDER BY date DESC,created_at DESC,id`,
      values,
    );
    if (r.rows.length > 100000)
      fail(
        400,
        "Для экспорта выберите не более 100 000 записей с помощью фильтров",
      );
    return r.rows;
  },
  async previewDeletion(query: Record<string, unknown>, actor: User) {
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      return deletionPreview(c, deletionFilters(query));
    });
  },
  async deleteFiltered(
    query: Record<string, unknown>,
    fingerprint: string,
    actor: User,
  ) {
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      await lock(c, "workflow");
      await c.query(
        "SELECT COUNT(*) FROM dbo.measurements WITH (TABLOCKX,HOLDLOCK)",
      );
      const f = deletionFilters(query);
      const current = await deletionPreview(c, f);
      if (current.fingerprint !== fingerprint)
        fail(
          409,
          "Записи изменились после предпросмотра. Повторно проверьте количество и подтвердите удаление.",
        );
      if (!current.count)
        fail(400, "Нет записей для удаления по выбранным фильтрам");
      // Audit the locked set; the measurement trigger retains linked corrections.
      await c.query(
        `INSERT INTO dbo.audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,details)
        SELECT $${f.values.length + 1},$${f.values.length + 2},'record.delete','measurements',LOWER(CONVERT(varchar(36),m.id)),m.sup,(SELECT m.* FOR JSON PATH,WITHOUT_ARRAY_WRAPPER,INCLUDE_NULL_VALUES),$${f.values.length + 3} FROM dbo.measurements m${f.where};
        DELETE FROM dbo.measurements${f.where};`,
        [
          ...f.values,
          actor.id,
          actor.login,
          JSON.stringify({ bulk: true, filters: f.selection }),
        ],
      );
      await audit(
        c,
        actor,
        "record.bulk_delete",
        "measurements",
        null,
        null,
        null,
        { count: current.count, filters: f.selection },
      );
      return { deleted: current.count };
    });
  },
  async save(
    recordId: string | null,
    d: z.infer<typeof recordSchema>,
    actor: User,
  ) {
    if (recordId && actor.role === "EMPLOYEE")
      fail(403, "EMPLOYEE не может редактировать сохранённые записи");
    if (recordId && !d.version) fail(400, "Не указана версия записи");
    return transaction(async (c) => {
      await assertActor(c, actor, !!recordId);
      await lock(c, "workflow");
      let previous;
      if (recordId) {
        previous = (
          await c.query(
            "SELECT * FROM dbo.measurements WITH (UPDLOCK,HOLDLOCK) WHERE id=$1",
            [recordId],
          )
        ).rows[0];
        if (!previous) fail(404, "Запись не найдена");
        if (actor.role === "EMPLOYEE")
          fail(403, "EMPLOYEE не может редактировать сохранённые записи");
        if (previous.version !== d.version)
          fail(409, "Запись изменена другим пользователем. Обновите страницу.");
      }
      let snapshot;
      if (previous?.mixture_id === d.mixtureId)
        snapshot = {
          name: previous.mixture_name,
          t_min: previous.t_min,
          t_max: previous.t_max,
        };
      else {
        snapshot = (
          await c.query(
            "SELECT * FROM dbo.mixtures WITH (HOLDLOCK) WHERE id=$1 AND archived=0",
            [d.mixtureId],
          )
        ).rows[0];
        if (!snapshot) fail(400, "Выберите действующую смесь");
      }
      const args = [
        d.sup,
        d.mixtureId,
        snapshot.name,
        snapshot.t_min,
        snapshot.t_max,
        d.actual,
        d.equipment,
      ];
      const sql = recordId
        ? output(
            "dbo.measurements",
            "UPDATE dbo.measurements SET sup=$1,mixture_id=$2,mixture_name=$3,t_min=$4,t_max=$5,actual=$6,equipment=$7,legacy_pending=CASE WHEN $6 IS NOT NULL THEN 0 ELSE legacy_pending END,version=version+1,updated_at=SYSUTCDATETIME() /*output*/ WHERE id=$8",
            recordColumns,
          )
        : output(
            "dbo.measurements",
            "INSERT INTO dbo.measurements(sup,mixture_id,mixture_name,t_min,t_max,actual,equipment,created_by) /*output*/ VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            recordColumns,
          );
      const r = await c.query<Measurement>(sql, [
        ...args,
        recordId ?? actor.id,
      ]);
      await audit(
        c,
        actor,
        recordId ? "record.update" : "record.create",
        "measurements",
        r.rows[0].id,
        previous ?? null,
        r.rows[0],
        {},
        d.sup,
      );
      return r.rows[0];
    });
  },
  async delete(id: string, version: number, actor: User) {
    if (actor.role === "EMPLOYEE")
      fail(403, "Недостаточно прав для удаления записи");
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      await lock(c, "workflow");
      const old = (
        await c.query(
          "SELECT * FROM dbo.measurements WITH (UPDLOCK,HOLDLOCK) WHERE id=$1 AND version=$2",
          [id, version],
        )
      ).rows[0];
      if (!old) fail(409, "Запись удалена или изменена. Обновите страницу.");
      await c.query("DELETE FROM dbo.measurements WHERE id=$1", [id]);
      await audit(
        c,
        actor,
        "record.delete",
        "measurements",
        id,
        old,
        null,
        {},
        old.sup,
      );
    });
  },
};
