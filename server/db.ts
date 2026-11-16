import "dotenv/config";
import sql from "mssql";

export function sqlConfig(
  database = process.env.SQLSERVER_DATABASE,
): sql.config {
  const { SQLSERVER_HOST, SQLSERVER_USER, SQLSERVER_PASSWORD, SQLSERVER_PORT } =
    process.env;
  if (!SQLSERVER_HOST || !database || !SQLSERVER_USER || !SQLSERVER_PASSWORD)
    throw new Error(
      "Укажите SQLSERVER_HOST, SQLSERVER_DATABASE, SQLSERVER_USER и SQLSERVER_PASSWORD.",
    );
  const port = Number(SQLSERVER_PORT ?? 1433);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Некорректный SQLSERVER_PORT.");
  return {
    server: SQLSERVER_HOST,
    database,
    user: SQLSERVER_USER,
    password: SQLSERVER_PASSWORD,
    port,
    connectionTimeout: 5000,
    requestTimeout: 60000,
    pool: { max: 12, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: true,
      trustServerCertificate:
        process.env.SQLSERVER_TRUST_CERTIFICATE === "true",
      useUTC: true,
      enableArithAbort: true,
    },
  };
}

let connecting: Promise<sql.ConnectionPool> | undefined;
export async function connection() {
  if (!connecting) {
    const db = new sql.ConnectionPool(sqlConfig());
    db.on("error", (error) => console.error("SQL Server:", error.message));
    connecting = db.connect().catch((error) => {
      connecting = undefined;
      throw error;
    });
  }
  return connecting;
}

const clearContext =
  "EXEC sys.sp_set_session_context @key=N'actor_id', @value=NULL; EXEC sys.sp_set_session_context @key=N'actor_login', @value=NULL; EXEC sys.sp_set_session_context @key=N'actor_name', @value=NULL; EXEC sys.sp_set_session_context @key=N'restoring', @value=NULL;";
const json = new Set([
  "payload",
  "initial_data",
  "before_data",
  "after_data",
  "details",
  "nok_rows",
  "before",
  "after",
  "initialData",
]);
function normalize(
  row: Record<string, unknown>,
  columns: Record<string, { type: unknown }>,
) {
  for (const [key, value] of Object.entries(row)) {
    const type = columns[key]?.type;
    if (value instanceof Date && type === sql.Date)
      row[key] = value.toISOString().slice(0, 10);
    else if (typeof value === "string" && type === sql.UniqueIdentifier)
      row[key] = value.toLowerCase();
    else if (typeof value === "string" && json.has(key))
      row[key] = JSON.parse(value);
  }
  return row;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}
async function query<T>(
  owner: sql.ConnectionPool | sql.Transaction,
  statement: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  const request = owner.request();
  for (const [i, value] of values.entries()) {
    const name = "p" + (i + 1);
    if (typeof value === "number")
      request.input(
        name,
        Number.isSafeInteger(value) &&
          value >= -2147483648 &&
          value <= 2147483647
          ? sql.Int
          : sql.Float,
        value,
      );
    else if (typeof value === "boolean") request.input(name, sql.Bit, value);
    else if (value instanceof Date) request.input(name, sql.DateTime2, value);
    else if (Buffer.isBuffer(value))
      request.input(name, sql.VarBinary(sql.MAX), value);
    else
      request.input(
        name,
        typeof value === "string" && value.length > 4000
          ? sql.NVarChar(sql.MAX)
          : sql.NVarChar(4000),
        value ?? null,
      );
  }
  // Positional binds used by the existing query builders; parameters remain out of SQL text.
  const result =
    /^\s*CREATE (?:OR ALTER )?TRIGGER\b/i.test(statement) && !values.length
      ? await request.batch(statement)
      : await request.query(
          "SET LOCK_TIMEOUT -1; SET ANSI_NULLS ON; SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; SET QUOTED_IDENTIFIER ON; SET ARITHABORT ON; SET CONCAT_NULL_YIELDS_NULL ON; SET NUMERIC_ROUNDABORT OFF;\n" +
            statement.replace(/\$(\d+)\b/g, "@p$1"),
        );
  const records = result.recordset;
  return {
    rows: records?.map((row) => normalize(row, records.columns) as T) ?? [],
    rowCount:
      records?.length ?? result.rowsAffected.reduce((sum, n) => sum + n, 0),
  };
}

export interface DbClient {
  query<T = any>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export const pool = {
  async query<T = any>(statement: string, values?: readonly unknown[]) {
    return query<T>(await connection(), statement, values);
  },
  async end() {
    const db = connecting;
    connecting = undefined;
    if (db) await (await db).close();
  },
};

export async function transaction<T>(
  work: (c: DbClient) => Promise<T>,
  isolation: sql.IIsolationLevel = sql.ISOLATION_LEVEL.READ_COMMITTED,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const tx = new sql.Transaction(await connection());
    await tx.begin(isolation);
    try {
      await query(tx, clearContext);
      const result = await work({
        query: (statement, values) => query(tx, statement, values),
      });
      await query(tx, clearContext);
      await tx.commit();
      return result;
    } catch (error) {
      await query(tx, clearContext).catch(() => {});
      await tx.rollback().catch(() => {});
      if (attempt >= 2 || (error as { number?: number }).number !== 1205)
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 25 * (attempt + 1) + Math.random() * 25),
      );
    }
  }
}

export async function lock(
  c: DbClient,
  resource: string,
  mode: "Shared" | "Exclusive" = "Exclusive",
  timeout = 15000,
) {
  const result = (
    await c.query<{ code: number }>(
      "SET NOCOUNT ON; DECLARE @code int; EXEC @code=sys.sp_getapplock @Resource=$1,@LockMode=$2,@LockOwner='Transaction',@LockTimeout=$3; SELECT @code AS code;",
      ["mixcontrol:" + resource, mode, timeout],
    )
  ).rows[0].code;
  if (result >= 0) return true;
  if (result === -1 && timeout === 0) return false;
  throw Object.assign(new Error("Данные заняты. Повторите действие."), {
    status: 409,
    number: result === -3 ? 1205 : 0,
  });
}

export const moscowDateSql =
  "CONVERT(date, SYSDATETIMEOFFSET() AT TIME ZONE 'Russian Standard Time')";
export const countsSql =
  "COUNT(*) AS total,COUNT(CASE WHEN status='OK' THEN 1 END) AS ok,COUNT(CASE WHEN status='NOK' THEN 1 END) AS nok,COUNT(CASE WHEN status IS NULL THEN 1 END) AS pending";
export function output(table: string, statement: string, projection = "*") {
  // SQL Server requires OUTPUT INTO when a table has an enabled trigger.
  return (
    "SET NOCOUNT ON; DECLARE @changed TABLE(id uniqueidentifier); " +
    statement.replace("/*output*/", "OUTPUT inserted.id INTO @changed(id)") +
    "; SELECT " +
    projection +
    " FROM " +
    table +
    " WHERE id IN (SELECT id FROM @changed);"
  );
}
