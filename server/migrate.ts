import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { lock, pool, transaction } from "./db.js";

const migrations = [
  "001-schema.sql",
  "002-workflow.sql",
  "003-login-format.sql",
  "004-retain-corrections.sql",
  "005-persistent-sessions.sql",
  "006-repeat-sup.sql",
  "007-sync-mixture-norms.sql",
];
export async function migrate() {
  return transaction(async (db) => {
    const supported = (
      await db.query<{ major: number; compatibility: number }>(
        "SELECT CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS major,compatibility_level AS compatibility FROM sys.databases WHERE name=DB_NAME()",
      )
    ).rows[0];
    if (supported.major < 15 || supported.compatibility < 150)
      throw new Error(
        "Требуется Microsoft SQL Server 2019 или новее и уровень совместимости базы 150 или выше.",
      );
    await lock(db, "schema");
    await db.query(
      "IF OBJECT_ID(N'dbo.schema_migrations', 'U') IS NULL CREATE TABLE dbo.schema_migrations(version int PRIMARY KEY);",
    );
    for (const [i, name] of migrations.entries()) {
      const version = i + 1;
      if (
        (
          await db.query(
            "SELECT version FROM dbo.schema_migrations WHERE version=$1",
            [version],
          )
        ).rowCount
      )
        continue;
      const source = await readFile(
        new URL("./mssql/" + name, import.meta.url),
        "utf8",
      );
      for (const batch of source.split(/^\s*GO\s*$/gim))
        if (batch.trim()) await db.query(batch);
      await db.query("INSERT INTO dbo.schema_migrations(version) VALUES($1)", [
        version,
      ]);
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  migrate()
    .then(() => console.log("Миграции SQL Server применены."))
    .catch((error: Error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
