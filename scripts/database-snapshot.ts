import { readFile, writeFile } from "node:fs/promises";
import sql from "mssql";
import { lock, pool, transaction, type DbClient } from "../server/db.js";

const layout = {
  users:
    "id:uuid login:str name:str password_hash:str role:str active:bit version:int created_at:time deleted_at:time",
  mixtures: "id:uuid name:str t_min:num t_max:num archived:bit created_at:time",
  measurements:
    "id:uuid date:date sup:str mixture_id:uuid mixture_name:str t_min:num t_max:num actual_min:num actual_max:num actual:num equipment:num legacy_pending:bit created_by:uuid version:int created_at:time updated_at:time",
  audit_log:
    "id:big actor_id:uuid actor_login:str action:str entity:str entity_id:str sup:str before_data:json after_data:json details:json created_at:time",
  corrective_actions:
    "id:uuid measurement_key:uuid measurement_id:uuid date:date sup:str mixture_name:str actual:num equipment:num delta:num initial_data:json source_deleted:bit status:str responsible_id:uuid work_done:str detected_at:time completed_at:time updated_at:time version:int",
  correction_events:
    "id:big correction_id:uuid kind:str actor_id:uuid actor_login:str actor_name:str before_data:json after_data:json created_at:time",
  correction_comments:
    "id:uuid correction_id:uuid original_correction_id:uuid author_id:uuid author_name:str author_login:str text:str created_at:time",
  daily_reports:
    "date:date total:int ok:int nok:int pending:int nok_percent:percent nok_rows:json version:int generated_at:time updated_at:time",
} as const;
type Table = keyof typeof layout;
const tables = Object.keys(layout) as Table[];
const identity = new Set<Table>(["audit_log", "correction_events"]);
const types: Record<string, string> = {
  uuid: "uniqueidentifier",
  str: "nvarchar(max)",
  bit: "bit",
  time: "datetime2(3)",
  num: "float",
  int: "int",
  date: "date",
  big: "bigint",
  percent: "decimal(5,2)",
  json: "nvarchar(max)",
};
const format = "mixcontrol-data-mssql-v1";

async function insert(
  c: DbClient,
  table: Table,
  rows: Record<string, unknown>[],
) {
  const fields = layout[table].split(" ").map((part) => part.split(":"));
  const columns = fields.map(([key]) => "[" + key + "]").join(",");
  const projected = fields
    .map(
      ([key, type]) =>
        "[" + key + "] " + types[type] + (type === "json" ? " AS JSON" : ""),
    )
    .join(",");
  const relation = "dbo." + table;
  const insertSql =
    "INSERT " +
    relation +
    "(" +
    columns +
    ") SELECT " +
    columns +
    " FROM OPENJSON($1) WITH (" +
    projected +
    ");";
  // Parameterized driver requests run in their own sp_executesql batch.
  const statement = identity.has(table)
    ? "SET IDENTITY_INSERT " +
      relation +
      " ON; BEGIN TRY " +
      insertSql +
      " SET IDENTITY_INSERT " +
      relation +
      " OFF; END TRY BEGIN CATCH SET IDENTITY_INSERT " +
      relation +
      " OFF; THROW; END CATCH;"
    : insertSql;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const part = rows.slice(offset, offset + 500).map((row) =>
      Object.fromEntries(
        fields.map(([key, type]) => {
          if (!Object.hasOwn(row, key))
            throw new Error("В снимке отсутствует поле " + table + "." + key);
          const value = row[key];
          return [
            key,
            type === "time" && typeof value === "string"
              ? value.replace(/Z$/, "")
              : value,
          ];
        }),
      ),
    );
    await c.query(statement, [JSON.stringify(part)]);
  }
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (!file || !["export", "restore"].includes(mode))
    throw new Error(
      "Использование: npm run db:snapshot -- export|restore <файл.json>",
    );
  if (mode === "export") {
    const rows = await transaction(async (c) => {
      const rows: Partial<Record<Table, unknown[]>> = {};
      for (const table of tables)
        rows[table] = (
          await c.query(
            "SELECT * FROM dbo." +
              table +
              " ORDER BY " +
              (table === "daily_reports" ? "date" : "id"),
          )
        ).rows;
      return rows;
    }, sql.ISOLATION_LEVEL.SERIALIZABLE);
    await writeFile(
      file,
      JSON.stringify(
        { format, exportedAt: new Date().toISOString(), tables: rows },
        null,
        2,
      ),
      { flag: "wx" },
    );
    console.log("Снимок сохранён:", file);
    return;
  }

  const backup = JSON.parse(await readFile(file, "utf8"));
  if (
    !(
      backup.format === format ||
      (backup.format === "mixcontrol-data-v1" && backup.schemaVersion === 11)
    ) ||
    !backup.tables ||
    !tables.every((t) => Array.isArray(backup.tables[t]))
  )
    throw new Error(
      "Нужен полный снимок MixControl 1.3 (схема 11) или MixControl 1.4/1.5/1.6. Рабочие данные не изменены.",
    );

  await transaction(async (c) => {
    await lock(c, "schema");
    await lock(c, "users");
    await lock(c, "workflow");
    for (const t of tables) {
      if (
        (
          await c.query(
            "SELECT TOP (1) 1 FROM dbo." + t + " WITH (TABLOCKX,HOLDLOCK)",
          )
        ).rowCount
      )
        throw new Error("Восстановление разрешено только в пустую базу.");
    }
    await c.query(
      "EXEC sys.sp_set_session_context @key=N'restoring',@value=1; ALTER TABLE dbo.measurements NOCHECK CONSTRAINT measurements_sup_seven_digits;",
    );
    for (const table of tables) await insert(c, table, backup.tables[table]);
    for (let i = 0; i < backup.tables.measurements.length; i += 500) {
      const source = backup.tables.measurements
        .slice(i, i + 500)
        .map((row: Record<string, unknown>) => ({
          id: row.id,
          status: row.status,
        }));
      const diff = await c.query(
        "SELECT TOP (1) m.id FROM dbo.measurements m JOIN OPENJSON($1) WITH(id uniqueidentifier,status varchar(3)) s ON s.id=m.id WHERE EXISTS(SELECT m.status EXCEPT SELECT s.status)",
        [JSON.stringify(source)],
      );
      if (diff.rowCount)
        throw new Error(
          "Итог OK/NOK не совпал для " + diff.rows[0].id + ". Перенос отменён.",
        );
    }
    await c.query(
      "ALTER TABLE dbo.measurements WITH NOCHECK CHECK CONSTRAINT measurements_sup_seven_digits; INSERT dbo.report_dirty_days(date) SELECT DISTINCT date FROM dbo.measurements; UPDATE dbo.change_revision SET revision=revision+1 WHERE topic='measurements';",
    );
  });
  console.log(
    "Перенос завершён. Войдите с прежним логином и паролем. Сессии не перенесены.",
  );
}
try {
  await main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
