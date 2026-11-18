import "dotenv/config";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";

const database = process.env.SQLSERVER_TEST_DATABASE;
if (
  !database ||
  !/^MixControlTest_[A-Za-z0-9_]+$/i.test(database) ||
  database.toLowerCase() === process.env.SQLSERVER_DATABASE?.toLowerCase()
)
  throw new Error(
    "Задайте SQLSERVER_TEST_DATABASE=MixControlTest_<суффикс> для отдельной пустой базы. Рабочая база не используется.",
  );
process.env.SQLSERVER_DATABASE = database;
const { pool } = await import("../server/db.js");
const workbookType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const password = "Test-Only-pass";
const oldDay = new Date(Date.now() - 3 * 86400000).toLocaleDateString("en-CA", {
  timeZone: "Europe/Moscow",
});
const today = new Date().toLocaleDateString("en-CA", {
  timeZone: "Europe/Moscow",
});

async function run(
  file: string,
  args: string[] = [],
  overrides: NodeJS.ProcessEnv = {},
) {
  const child = spawn(process.execPath, ["--import", "tsx", file, ...args], {
    env: { ...process.env, ...overrides },
    stdio: "pipe",
    windowsHide: true,
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  const [code] = await once(child, "exit");
  assert.equal(code, 0, logs);
}
function cookie(response: Response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header);
  return header.split(";")[0];
}

test("MixControl 1.5 end-to-end — SQL Server 2019", async (t) => {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((r) => socket.close(() => r()));
  const base = "http://127.0.0.1:" + port + "/api";
  let child: ReturnType<typeof spawn> | undefined;
  let logs = "";
  try {
    assert.equal(
      (
        await pool.query(
          "SELECT TOP (1) 1 FROM sys.tables WHERE is_ms_shipped=0",
        )
      ).rowCount,
      0,
      "База проверки должна быть пустой",
    );
    const { major, compatibility } = (
      await pool.query(
        "SELECT CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS major,compatibility_level AS compatibility FROM sys.databases WHERE name=DB_NAME()",
      )
    ).rows[0];
    assert.equal(
      major,
      15,
      "Для подтверждения совместимости используйте настоящий SQL Server 2019",
    );
    assert.equal(compatibility, 150);
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        COOKIE_SECURE: "false",
        TRUST_PROXY: "0",
      },
      stdio: "pipe",
      windowsHide: true,
    });
    child.stdout?.on("data", (d) => (logs += d));
    child.stderr?.on("data", (d) => (logs += d));
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) break;
      try {
        ready = (
          await fetch(base + "/health", { signal: AbortSignal.timeout(500) })
        ).ok;
      } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ready, logs);
    await run("server/migrate.ts"); // Startup migration must be safe to rerun.

    const send = (url: string, method = "GET", body?: unknown, token = "") =>
      fetch(base + url, {
        method,
        headers: {
          ...(token ? { Cookie: token } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const expect = async (promise: Promise<Response>, status: number) => {
      const r = await promise;
      assert.equal(r.status, status, (await r.clone().text()) + "\n" + logs);
      return r;
    };
    const sign = (login: string, pass = password) =>
      send("/auth/login", "POST", { login, password: pass });
    const setupBody = {
      name: "Основной пользователь",
      login: "primary-key",
      password,
    };
    const setup = await expect(send("/auth/setup", "POST", setupBody), 201);
    const key = cookie(setup);
    const keyUser = await setup.json();
    let user: any,
      adminUser: any,
      admin = "",
      employee = "",
      mix = "",
      record: any;
    const input = (
      sup: string,
      actual: number | null = 125,
      equipment: number | null = 124,
    ) => ({ sup, mixtureId: mix, actual, equipment });
    await t.test(
      "Авторизация, три роли, хеш, уникальность, настройки аккаунта",
      async () => {
        await expect(send("/records"), 401);
        await expect(send("/auth/setup", "POST", setupBody), 409);
        adminUser = await (
          await expect(
            send(
              "/users",
              "POST",
              { name: "Админ", login: "admin1", password, role: "ADMIN" },
              key,
            ),
            201,
          )
        ).json();
        admin = cookie(await expect(sign("admin1"), 200));
        user = await (
          await expect(
            send(
              "/users",
              "POST",
              {
                name: "Сотрудник",
                login: "employee_1",
                password,
                role: "EMPLOYEE",
              },
              admin,
            ),
            201,
          )
        ).json();
        employee = cookie(await expect(sign("employee_1"), 200));
        await expect(send("/users"), 401);
        await expect(send("/users", "GET", undefined, employee), 403);
        await expect(
          send(
            "/users",
            "POST",
            { name: "Админ 2", login: "ADMIN1", password, role: "ADMIN" },
            key,
          ),
          409,
        );
        await expect(
          send(
            "/users",
            "POST",
            { name: "Ключ 2", login: "primary2", password, role: "KEYUSER" },
            key,
          ),
          409,
        );
        await expect(
          send(
            "/auth/credentials",
            "PUT",
            {
              kind: "password",
              password: "new-test-pass",
              currentPassword: password,
            },
            admin,
          ),
          403,
        );
        assert.match(
          (
            await pool.query(
              "SELECT password_hash FROM dbo.users WHERE id=$1",
              [keyUser.id],
            )
          ).rows[0].password_hash,
          /^scrypt\$/,
        );
      },
    );
    await t.test(
      "Смеси, конкурентный SUP, статусы и запреты сотрудника",
      async () => {
        mix = (
          await (
            await expect(
              send(
                "/mixtures",
                "POST",
                { name: "Смесь для проверки", tMin: 100, tMax: 150 },
                admin,
              ),
              201,
            )
          ).json()
        ).id;
        // NEWSEQUENTIALID on Windows can set bits that strict RFC validation rejects.
        const sequentialId = "24563190-5cb2-f101-bef7-00155d100e00";
        await pool.query("UPDATE dbo.mixtures SET id=$1 WHERE id=$2", [sequentialId, mix]);
        mix = sequentialId;
        await expect(
          send("/mixtures/" + mix, "PUT", { name: "Смесь для проверки", tMin: 100, tMax: 150 }, admin),
          200,
        );
        await expect(send("/records?mixtureId=" + mix, "GET", undefined, employee), 200);
        await expect(send("/records?mixtureId=not-a-guid", "GET", undefined, employee), 400);
        const opts = await (
          await expect(
            send("/mixtures/options", "GET", undefined, employee),
            200,
          )
        ).json();
        assert.equal(opts[0].tMin, null);
        await expect(
          send(
            "/mixtures",
            "POST",
            { name: "СМЕСЬ ДЛЯ ПРОВЕРКИ", tMin: 80, tMax: 120 },
            admin,
          ),
          409,
        );
        await expect(
          send(
            "/mixtures",
            "POST",
            { name: "Ввод сотрудника", tMin: 80, tMax: 120 },
            employee,
          ),
          403,
        );
        await expect(send("/records", "POST", input("wrong"), employee), 400);
        const raced = await Promise.all([
          send("/records", "POST", input("0000100"), employee),
          send("/records", "POST", input("0000100"), admin),
        ]);
        assert.deepEqual(raced.map((r) => r.status).sort(), [201, 409]);
        record = await raced.find((r) => r.status === 201)!.json();
        assert.equal(record.status, "OK");
        assert.equal(record.date, today);
        await expect(
          send(
            "/records/" + record.id,
            "PUT",
            { ...input("0000100"), version: record.version },
            employee,
          ),
          403,
        );
        await expect(send("/mixtures/" + mix, "DELETE", undefined, admin), 409);
        const out = await (
          await expect(
            send("/records", "POST", input("0000101", 155, 97), employee),
            201,
          )
        ).json();
        assert.equal(out.status, "NOK");
        const exact = await (
          await expect(
            send("/records", "POST", input("0000102", 103.2, 100.2), employee),
            201,
          )
        ).json();
        assert.equal(exact.delta, 3);
        const pending = await (
          await expect(
            send("/records", "POST", input("0000103", null, 125), employee),
            201,
          )
        ).json();
        assert.equal(pending.status, null);
        assert.equal(
          (
            await (
              await expect(
                send("/corrections/summary", "GET", undefined, key),
                200,
              )
            ).json()
          ).active,
          1,
        );
      },
    );
    await t.test(
      "Корректировки, история, Excel, отчёты, сохранение и удаление KEYUSER",
      async () => {
        const tasks = await (
          await expect(send("/corrections", "GET", undefined, admin), 200)
        ).json();
        const task = tasks.rows[0];
        const history = await (
          await expect(
            send(
              "/corrections/" + task.id,
              "PUT",
              {
                status: "DONE",
                responsibleId: adminUser.id,
                workDone: "Образец проверен",
                version: task.version,
              },
              admin,
            ),
            200,
          )
        ).json();
        assert.equal(history.correction.status, "DONE");
        assert.ok(history.events.some((e: any) => e.kind === "detected"));
        assert.ok(history.events.some((e: any) => e.kind === "updated"));
        const wb = new ExcelJS.Workbook();
        const journal = wb.addWorksheet("Журнал");
        journal.addRow([
          "Дата",
          "SUP",
          "Смесь",
          "T min",
          "T max",
          "T(fact)",
          "T(обор)",
          "Итог",
        ]);
        journal.addRow([
          oldDay,
          "0000120",
          "Смесь для проверки",
          100,
          150,
          155,
          97,
          "",
        ]);
        journal.addRow([
          oldDay,
          "0000121",
          "Смесь для проверки",
          100,
          150,
          125,
          124,
          "",
        ]);
        const upload = await expect(
          fetch(base + "/records/import/preview", {
            method: "POST",
            headers: { Cookie: key, "Content-Type": workbookType },
            body: Buffer.from(await wb.xlsx.writeBuffer()),
          }),
          200,
        );
        const preview = await upload.json();
        assert.equal(preview.errorCount, 0);
        await expect(
          send("/records/import/confirm", "POST", { id: preview.id }, key),
          200,
        );
        await expect(
          send("/records/import/confirm", "POST", { id: preview.id }, key),
          409,
        );
        const report = await (
          await expect(
            send("/reports?date=" + oldDay, "GET", undefined, employee),
            200,
          )
        ).json();
        assert.deepEqual(
          [report.total, report.ok, report.nok, report.nokPercent],
          [2, 1, 1, 50],
        );
        assert.match(report.rows[0].deviation, /T\(fact\).*T\(обор\)/);
        await expect(
          send("/reports?date=" + today, "GET", undefined, key),
          400,
        );
        const exported = await expect(
          send(
            "/records/export?from=" + oldDay + "&to=" + oldDay,
            "GET",
            undefined,
            key,
          ),
          200,
        );
        const book = new ExcelJS.Workbook();
        const bytes = Buffer.from(await exported.arrayBuffer());
        await book.xlsx.load(
          bytes as unknown as Parameters<typeof book.xlsx.load>[0],
        );
        assert.equal(book.worksheets[0].rowCount, 3);
        const filtered = await (
          await expect(
            send(
              "/records/delete-preview?search=0000101",
              "GET",
              undefined,
              key,
            ),
            200,
          )
        ).json();
        assert.equal(filtered.count, 1);
        await expect(
          send(
            "/records/by-filter",
            "DELETE",
            {
              filters: { search: "0000101" },
              fingerprint: filtered.fingerprint,
            },
            key,
          ),
          200,
        );
        assert.equal(
          (await pool.query("SELECT id FROM dbo.corrective_actions WHERE id=$1", [task.id])).rowCount,
          1,
        );
        const retained = await (await expect(
          send("/corrections/" + task.id + "/history", "GET", undefined, admin), 200,
        )).json();
        assert.equal(retained.correction.sourceDeleted, true);
        assert.equal(retained.correction.measurementId, null);
        assert.equal(retained.correction.status, "DONE");
        assert.equal(retained.correction.workDone, "Образец проверен");
        assert.ok(retained.events.some((e: any) => e.kind === "measurement_deleted"));
        const deleteUrl = "/corrections/" + task.id + "?version=" + retained.correction.version;
        await expect(send(deleteUrl, "DELETE", undefined, admin), 403);
        await expect(send(deleteUrl, "DELETE", undefined, employee), 403);
        await expect(send("/corrections/" + task.id + "?version=" + task.version, "DELETE", undefined, key), 409);
        await expect(send(deleteUrl, "DELETE", undefined, key), 204);
        await expect(send("/corrections/" + task.id, "GET", undefined, key), 404);
        assert.equal((await pool.query(
          "SELECT id FROM dbo.audit_log WHERE action='correction.deleted' AND entity_id=$1",
          [task.id],
        )).rowCount, 1);

        // Active actions also survive single-record deletion; unrelated actions remain.
        const source = await (await expect(send("/records", "POST", input("0000130", 130, 120), admin), 201)).json();
        let active = (await (await expect(send("/corrections?search=0000130", "GET", undefined, key), 200)).json()).rows[0];
        assert.ok(active);
        const changed = await (await expect(send("/records/" + source.id, "PUT", {
          ...input("0000130", 122, 121), version: source.version,
        }, admin), 200)).json();
        active = (await (await expect(send("/corrections/" + active.id, "GET", undefined, key), 200)).json()).correction;
        assert.equal(active.delta, 1); // Correcting temperatures must not delete the action.
        await expect(send("/records/" + source.id + "?version=" + changed.version, "DELETE", undefined, admin), 204);
        active = (await (await expect(send("/corrections/" + active.id, "GET", undefined, key), 200)).json()).correction;
        assert.equal(active.sourceDeleted, true);
        assert.equal(active.measurementKey, source.id);
        const beforeCount = (await (await expect(send("/corrections/summary", "GET", undefined, key), 200)).json()).active;
        await expect(send("/corrections/" + active.id + "?version=" + active.version, "DELETE", undefined, key), 204);
        assert.equal((await (await expect(send("/corrections/summary", "GET", undefined, key), 200)).json()).active, beforeCount - 1);
        const untouched = (await (await expect(send("/corrections?search=0000120", "GET", undefined, key), 200)).json()).rows;
        assert.equal(untouched.length, 1);
        // Leave this orphan with its immutable key to verify snapshot restoration.
        const original = (await (await expect(send("/records?search=0000120", "GET", undefined, key), 200)).json()).records[0];
        await expect(send("/records/" + original.id + "?version=" + original.version, "DELETE", undefined, admin), 204);

        assert.equal(
          (
            await pool.query(
              "SELECT id FROM dbo.audit_log WHERE action='correction.source_deleted' AND entity_id=$1",
              [task.id],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      "Пагинация, SSE, блокировка редактирования, переиспользование логина",
      async () => {
        const controller = new AbortController();
        const stream = await fetch(base + "/events", {
          headers: { Cookie: admin },
          signal: controller.signal,
        });
        const reader = stream.body!.getReader();
        try {
          for (let i = 0; i < 15; i++)
            await expect(
              send(
                "/records",
                "POST",
                input(String(200 + i).padStart(7, "0")),
                employee,
              ),
              201,
            );
          const read = new TextDecoder();
          const timeout = setTimeout(() => controller.abort(), 6000);
          try {
            let contents = "";
            while (!contents.includes('"measurements"')) {
              const data = await reader.read();
              assert.ok(!data.done);
              contents += read.decode(data.value, { stream: true });
            }
          } finally {
            clearTimeout(timeout);
          }
        } finally {
          controller.abort();
        }
        const p1 = await (
          await expect(
            send(
              "/records?size=15&page=1&sort=sup&direction=asc",
              "GET",
              undefined,
              employee,
            ),
            200,
          )
        ).json();
        const p2 = await (
          await expect(
            send(
              "/records?size=15&page=2&sort=sup&direction=asc",
              "GET",
              undefined,
              employee,
            ),
            200,
          )
        ).json();
        assert.equal(p1.records.length, 15);
        assert.ok(p2.records.length > 0);
        assert.ok(
          !p2.records.some((r: any) =>
            p1.records.some((s: any) => s.id === r.id),
          ),
        );
        const update = () =>
          send(
            "/records/" + record.id,
            "PUT",
            { ...input("0000100", 122, 121), version: record.version },
            admin,
          );
        const updates = await Promise.all([update(), update()]);
        assert.deepEqual(updates.map((r) => r.status).sort(), [200, 409]);
        const version = (
          await (
            await expect(send("/users", "GET", undefined, admin), 200)
          ).json()
        ).find((u: any) => u.id === user.id).version;
        await expect(
          send(
            "/users/" + user.id + "?version=" + version,
            "DELETE",
            undefined,
            admin,
          ),
          204,
        );
        await expect(send("/auth/me", "GET", undefined, employee), 401);
        const replacement = await (
          await expect(
            send(
              "/users",
              "POST",
              {
                name: "Другой сотрудник",
                login: user.login,
                password,
                role: "EMPLOYEE",
              },
              admin,
            ),
            201,
          )
        ).json();
        assert.notEqual(replacement.id, user.id);
        assert.ok(
          (
            await pool.query(
              "SELECT id FROM dbo.measurements WHERE created_by=$1",
              [user.id],
            )
          ).rowCount,
        );
      },
    );
    await t.test("Смена логина и пароля KEYUSER, отзыв сессий", async () => {
      await expect(
        send(
          "/auth/credentials",
          "PUT",
          { kind: "login", login: "newprimary", currentPassword: "wrong" },
          key,
        ),
        403,
      );
      await expect(
        send(
          "/auth/credentials",
          "PUT",
          { kind: "login", login: "newprimary", currentPassword: password },
          key,
        ),
        204,
      );
      await expect(sign("primary-key"), 401);
      await expect(send("/auth/me", "GET", undefined, key), 401);
      const fresh = cookie(await expect(sign("newprimary"), 200));
      await expect(
        send(
          "/auth/credentials",
          "PUT",
          {
            kind: "password",
            password: "fresh-pass",
            currentPassword: password,
          },
          fresh,
        ),
        204,
      );
      await expect(sign("newprimary"), 401);
      const profile = await (
        await expect(sign("newprimary", "fresh-pass"), 200)
      ).json();
      assert.equal(profile.id, keyUser.id);
    });

    await t.test("Линии MB/FMF: алфавит, регистр, страницы, Excel и удаление", async () => {
      const names = ["M1-line", "m2-line", "М1-line", "м2-line", " m1-space", "M3-line", "FMF-line", "XM1-line"];
      const mbSups = new Set(["8800000", "8800001", "8800002", "8800003", "8800004"]);
      for (const [i, name] of names.entries()) {
        const mixture = await (await expect(send("/mixtures", "POST", {
          name, tMin: 100, tMax: 150,
        }, admin), 201)).json();
        await expect(send("/records", "POST", {
          sup: String(8800000 + i), mixtureId: mixture.id, actual: 125, equipment: 125,
        }, admin), 201);
      }
      const page = await (await expect(send("/records?search=880000&line=MB&size=2", "GET", undefined, admin), 200)).json();
      assert.equal(page.total, 5);
      assert.equal(page.records.length, 2);
      assert.ok(page.records.every((r: any) => mbSups.has(r.sup)));
      const fmf = await (await expect(send("/records?search=880000&line=FMF", "GET", undefined, admin), 200)).json();
      assert.equal(fmf.total, 3);
      assert.ok(fmf.records.every((r: any) => !mbSups.has(r.sup)));
      await expect(send("/records?line=BAD", "GET", undefined, admin), 400);
      const response = await expect(send("/records/export?search=880000&line=MB", "GET", undefined, admin), 200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.from(await response.arrayBuffer()) as any);
      assert.equal(book.worksheets[0].actualRowCount, 6);
      const preview = await (await expect(send("/records/delete-preview?search=880000&line=MB", "GET", undefined, admin), 200)).json();
      assert.equal(preview.count, 5);
      await expect(send("/records/by-filter", "DELETE", {
        filters: { search: "880000", line: "MB" }, fingerprint: preview.fingerprint,
      }, admin), 200);
      const remaining = await (await expect(send("/records?search=880000", "GET", undefined, admin), 200)).json();
      assert.equal(remaining.total, 3);
      assert.ok(remaining.records.every((r: any) => !mbSups.has(r.sup)));
    });

    await t.test("Резервная копия и пробное восстановление", async () => {
      const restoreDb = process.env.SQLSERVER_TEST_RESTORE_DATABASE;
      assert.ok(
        restoreDb &&
          /^MixControlTest_[A-Za-z0-9_]+$/i.test(restoreDb) &&
          restoreDb.toLowerCase() !== database.toLowerCase(),
        "Для сквозной проверки переноса задайте вторую пустую базу SQLSERVER_TEST_RESTORE_DATABASE.",
      );
      const tmp = await mkdtemp(join(tmpdir(), "mixcontrol-mssql-test-"));
      const file = join(tmp, "snapshot.json");
      const target = { SQLSERVER_DATABASE: restoreDb };
      const restoreCheck = new (await import("mssql")).default.ConnectionPool(
        (await import("../server/db.js")).sqlConfig(restoreDb),
      );
      try {
        await restoreCheck.connect();
        assert.equal(
          (
            await restoreCheck
              .request()
              .query("SELECT TOP (1) 1 FROM sys.tables WHERE is_ms_shipped=0")
          ).recordset.length,
          0,
        );
        await run("scripts/database-snapshot.ts", ["export", file]);
        // Exercise the PostgreSQL 1.3 interchange format and preservation of older SUPs.
        const legacy = JSON.parse(await readFile(file, "utf8"));
        legacy.format = "mixcontrol-data-v1";
        legacy.schemaVersion = 11;
        for (const table of ["audit_log", "correction_events"])
          for (const row of legacy.tables[table]) row.id = String(row.id);
        const legacyMeasurement = legacy.tables.measurements.find(
          (row: any) => row.sup === "0000100",
        );
        legacyMeasurement.sup = "LEGACY-X";
        await writeFile(file, JSON.stringify(legacy));
        await run("server/migrate.ts", [], target);
        await run("scripts/database-snapshot.ts", ["restore", file], target);
        assert.equal(
          (
            await restoreCheck
              .request()
              .query("SELECT status FROM dbo.measurements WHERE sup='LEGACY-X'")
          ).recordset[0].status,
          "OK",
        );
        await assert.rejects(
          restoreCheck
            .request()
            .query(
              "UPDATE dbo.measurements SET sup='bad' WHERE sup='LEGACY-X'",
            ),
        );
        for (const table of ["audit_log", "correction_events"]) {
          const statement =
            "SELECT CONVERT(varchar(20),id) AS id FROM dbo." +
            table +
            " ORDER BY id";
          assert.deepEqual(
            (await restoreCheck.request().query(statement)).recordset.map(
              (row) => row.id,
            ),
            (await pool.query(statement)).rows.map((row) => row.id),
          );
        }
        for (const table of [
          "measurements",
          "users",
          "corrective_actions",
          "correction_events",
          "daily_reports",
          "audit_log",
        ]) {
          const statement = "SELECT COUNT(*) AS count FROM dbo." + table;
          assert.equal(
            (await restoreCheck.request().query(statement)).recordset[0].count,
            (await pool.query(statement)).rows[0].count,
            table,
          );
        }
      } finally {
        await restoreCheck.close();
        await unlink(file).catch(() => {});
        await rmdir(tmp).catch(() => {});
      }
    });
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await pool.end();
  }
});
