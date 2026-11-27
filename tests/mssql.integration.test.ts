import type { Measurement } from "../shared/domain.js";
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

test("MixControl 1.6 end-to-end — SQL Server 2019", async (t) => {
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
      "Сессия сохраняется без 12-часового лимита и отзывается при выходе",
      async () => {
        const login = await expect(sign(setupBody.login), 200);
        const token = cookie(login);
        assert.match(login.headers.get("set-cookie")!, /Max-Age=34560000/);
        assert.match(login.headers.get("set-cookie")!, /HttpOnly/);
        const sessions = (
          await pool.query(
            "SELECT expires_at FROM dbo.sessions WHERE user_id=$1",
            [keyUser.id],
          )
        ).rows;
        assert.ok(
          sessions.length > 0 && sessions.every((s) => s.expires_at === null),
        );
        await pool.query(
          "UPDATE dbo.sessions SET created_at=DATEADD(day,-30,SYSUTCDATETIME()) WHERE user_id=$1",
          [keyUser.id],
        );
        const me = await expect(send("/auth/me", "GET", undefined, token), 200);
        assert.match(me.headers.get("set-cookie")!, /Max-Age=34560000/);
        await expect(send("/auth/logout", "POST", undefined, token), 204);
        await expect(send("/auth/me", "GET", undefined, token), 401);
        await expect(send("/auth/me", "GET", undefined, key), 200);
      },
    );
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
        await pool.query("UPDATE dbo.mixtures SET id=$1 WHERE id=$2", [
          sequentialId,
          mix,
        ]);
        mix = sequentialId;
        await expect(
          send(
            "/mixtures/" + mix,
            "PUT",
            { name: "Смесь для проверки", tMin: 100, tMax: 150 },
            admin,
          ),
          200,
        );
        await expect(
          send("/records?mixtureId=" + mix, "GET", undefined, employee),
          200,
        );
        await expect(
          send("/records?mixtureId=not-a-guid", "GET", undefined, employee),
          400,
        );
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
        assert.deepEqual(
          raced.map((r) => r.status),
          [201, 201],
        );
        record = await raced[0].json();
        const repeated = await raced[1].json();
        assert.notEqual(record.id, repeated.id);
        assert.equal(record.status, "OK");
        assert.equal(record.date, today);
        record = await (
          await expect(
            send(
              "/records/" + record.id,
              "PUT",
              { sup: "0000100", mixtureId: mix, version: record.version },
              employee,
            ),
            200,
          )
        ).json();
        assert.equal(record.actual, 125);
        assert.equal(record.equipment, 124);
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
        for (const actor of [employee, admin, key]) {
          await expect(
            send("/records", "POST", input("0000103", null, 125), actor),
            400,
          );
          await expect(
            send("/records", "POST", input("0000103", 125, null), actor),
            400,
          );
        }
        await expect(
          send(
            "/records/" + record.id,
            "PUT",
            { ...input("0000100", null, 125), version: record.version },
            admin,
          ),
          400,
        );
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
      "Сотрудник: собственные SUP и смесь, запреты, версии и исторические температуры",
      async () => {
        const otherMixture = await (
          await expect(
            send(
              "/mixtures",
              "POST",
              { name: "Исправленная смесь", tMin: 100, tMax: 140 },
              admin,
            ),
            201,
          )
        ).json();
        let own = await (
          await expect(
            send("/records", "POST", input("7770001"), employee),
            201,
          )
        ).json();
        const foreign = await (
          await expect(send("/records", "POST", input("7770002"), admin), 201)
        ).json();
        const changed = {
          sup: "7770002",
          mixtureId: otherMixture.id,
          version: own.version,
        };
        await expect(
          send(
            "/records/" + foreign.id,
            "PUT",
            { ...changed, version: foreign.version },
            employee,
          ),
          403,
        );
        for (const patch of [{ actual: 126 }, { equipment: 126 }]) {
          await expect(
            send(
              "/records/" + own.id,
              "PUT",
              { ...changed, ...patch },
              employee,
            ),
            403,
          );
        }
        for (const patch of [
          { date: oldDay },
          { createdBy: adminUser.id },
          { tMin: 0 },
        ]) {
          await expect(
            send(
              "/records/" + own.id,
              "PUT",
              { ...changed, ...patch },
              employee,
            ),
            400,
          );
        }
        const before = own;
        own = await (
          await expect(
            send("/records/" + own.id, "PUT", changed, employee),
            200,
          )
        ).json();
        assert.equal(own.sup, "7770002");
        assert.equal(own.mixtureId, otherMixture.id);
        assert.equal(own.createdBy, user.id);
        assert.equal(own.date, before.date);
        assert.deepEqual(
          [own.actual, own.equipment],
          [before.actual, before.equipment],
        );
        assert.deepEqual([own.tMin, own.tMax], [100, 140]);
        await expect(send("/records/" + own.id, "PUT", changed, employee), 409);
        await expect(
          send(
            "/records/" + own.id + "?version=" + own.version,
            "DELETE",
            undefined,
            employee,
          ),
          403,
        );
        const concurrent = await Promise.all(
          [1, 2].map(() =>
            send(
              "/records/" + own.id,
              "PUT",
              { sup: own.sup, mixtureId: own.mixtureId, version: own.version },
              employee,
            ),
          ),
        );
        assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
        const legacy = await (
          await expect(
            send("/records", "POST", input("7770003"), employee),
            201,
          )
        ).json();
        await pool.query(
          "UPDATE dbo.measurements SET actual=NULL,equipment=NULL,legacy_pending=1,actual_min=120,actual_max=130 WHERE id=$1",
          [legacy.id],
        );
        const migrated = await (
          await expect(
            send(
              "/records/" + legacy.id,
              "PUT",
              { sup: "7770004", mixtureId: mix, version: legacy.version },
              employee,
            ),
            200,
          )
        ).json();
        assert.deepEqual(
          [
            migrated.actual,
            migrated.equipment,
            migrated.actualMin,
            migrated.actualMax,
            migrated.legacyPending,
          ],
          [null, null, 120, 130, true],
        );
        assert.ok(
          (
            await pool.query(
              "SELECT id FROM dbo.audit_log WHERE action='record.update' AND actor_id=$1 AND entity_id=$2",
              [user.id, own.id],
            )
          ).rowCount,
        );
      },
    );
    await t.test(
      "Повторный SUP: отдельная история NOK/OK, страницы, фильтры и удаление по ID",
      async () => {
        const attempts = [];
        for (let i = 0; i < 17; i++)
          attempts.push(
            await (
              await expect(
                send(
                  "/records",
                  "POST",
                  input("7788888", i === 0 ? 155 : 125, i === 0 ? 154 : 124),
                  employee,
                ),
                201,
              )
            ).json(),
          );
        assert.equal(new Set(attempts.map((r) => r.id)).size, 17);
        assert.equal(attempts[0].status, "NOK");
        assert.equal(attempts[1].status, "OK");
        const list = async (query = "") =>
          (
            await expect(
              send(
                "/records?search=7788888&sort=sup&direction=asc" + query,
                "GET",
                undefined,
                employee,
              ),
              200,
            )
          ).json();
        const first = await list("&page=1"),
          second = await list("&page=2");
        assert.equal(first.total, 17);
        assert.equal(first.records.length, 15);
        assert.equal(second.records.length, 2);
        assert.ok(
          !second.records.some((r: any) =>
            first.records.some((s: any) => s.id === r.id),
          ),
        );
        const nok = await list("&status=NOK");
        assert.equal(nok.total, 1);
        assert.equal(nok.records[0].id, attempts[0].id);
        const filtered = await list(
          "&mixtureId=" + mix + "&from=" + today + "&to=" + today,
        );
        assert.equal(filtered.total, 17);
        await expect(
          send(
            "/records/" + attempts[1].id + "?version=" + attempts[1].version,
            "DELETE",
            undefined,
            admin,
          ),
          204,
        );
        assert.equal((await list()).total, 16);
        assert.equal((await list("&status=NOK")).records[0].id, attempts[0].id);
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
          (
            await pool.query(
              "SELECT id FROM dbo.corrective_actions WHERE id=$1",
              [task.id],
            )
          ).rowCount,
          1,
        );
        const retained = await (
          await expect(
            send(
              "/corrections/" + task.id + "/history",
              "GET",
              undefined,
              admin,
            ),
            200,
          )
        ).json();
        assert.equal(retained.correction.sourceDeleted, true);
        assert.equal(retained.correction.measurementId, null);
        assert.equal(retained.correction.status, "DONE");
        assert.equal(retained.correction.workDone, "Образец проверен");
        assert.ok(
          retained.events.some((e: any) => e.kind === "measurement_deleted"),
        );
        const deleteUrl =
          "/corrections/" + task.id + "?version=" + retained.correction.version;
        await expect(send(deleteUrl, "DELETE", undefined, admin), 403);
        await expect(send(deleteUrl, "DELETE", undefined, employee), 403);
        await expect(
          send(
            "/corrections/" + task.id + "?version=" + task.version,
            "DELETE",
            undefined,
            key,
          ),
          409,
        );
        await expect(send(deleteUrl, "DELETE", undefined, key), 204);
        await expect(
          send("/corrections/" + task.id, "GET", undefined, key),
          404,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT id FROM dbo.audit_log WHERE action='correction.deleted' AND entity_id=$1",
              [task.id],
            )
          ).rowCount,
          1,
        );

        // Active actions also survive single-record deletion; unrelated actions remain.
        const source = await (
          await expect(
            send("/records", "POST", input("0000130", 130, 120), admin),
            201,
          )
        ).json();
        let active = (
          await (
            await expect(
              send("/corrections?search=0000130", "GET", undefined, key),
              200,
            )
          ).json()
        ).rows[0];
        assert.ok(active);
        const changed = await (
          await expect(
            send(
              "/records/" + source.id,
              "PUT",
              {
                ...input("0000130", 122, 121),
                version: source.version,
              },
              admin,
            ),
            200,
          )
        ).json();
        active = (
          await (
            await expect(
              send("/corrections/" + active.id, "GET", undefined, key),
              200,
            )
          ).json()
        ).correction;
        assert.equal(active.delta, 1); // Correcting temperatures must not delete the action.
        await expect(
          send(
            "/records/" + source.id + "?version=" + changed.version,
            "DELETE",
            undefined,
            admin,
          ),
          204,
        );
        active = (
          await (
            await expect(
              send("/corrections/" + active.id, "GET", undefined, key),
              200,
            )
          ).json()
        ).correction;
        assert.equal(active.sourceDeleted, true);
        assert.equal(active.measurementKey, source.id);
        const beforeCount = (
          await (
            await expect(
              send("/corrections/summary", "GET", undefined, key),
              200,
            )
          ).json()
        ).active;
        await expect(
          send(
            "/corrections/" + active.id + "?version=" + active.version,
            "DELETE",
            undefined,
            key,
          ),
          204,
        );
        assert.equal(
          (
            await (
              await expect(
                send("/corrections/summary", "GET", undefined, key),
                200,
              )
            ).json()
          ).active,
          beforeCount - 1,
        );
        const untouched = (
          await (
            await expect(
              send("/corrections?search=0000120", "GET", undefined, key),
              200,
            )
          ).json()
        ).rows;
        assert.equal(untouched.length, 1);
        // Leave this orphan with its immutable key to verify snapshot restoration.
        const original = (
          await (
            await expect(
              send("/records?search=0000120", "GET", undefined, key),
              200,
            )
          ).json()
        ).records[0];
        await expect(
          send(
            "/records/" + original.id + "?version=" + original.version,
            "DELETE",
            undefined,
            admin,
          ),
          204,
        );

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
      "Импорт повторных SUP не перезаписывает историю, обновление только по ID",
      async () => {
        const makeBook = async (rows: any[][], omitEquipment = false) => {
          const wb = new ExcelJS.Workbook(),
            ws = wb.addWorksheet("Журнал");
          const headings = [
            "Дата",
            "SUP",
            "Смесь",
            "T min",
            "T max",
            "T(fact)",
            "T(обор)",
            "Итог",
            "ID измерения",
          ];
          ws.addRow(headings.filter((_, i) => !omitEquipment || i !== 6));
          for (const row of rows)
            ws.addRow(row.filter((_, i) => !omitEquipment || i !== 6));
          return Buffer.from(await wb.xlsx.writeBuffer());
        };
        const preview = async (rows: any[][], omitEquipment = false) =>
          (
            await expect(
              fetch(base + "/records/import/preview", {
                method: "POST",
                headers: { Cookie: key, "Content-Type": workbookType },
                body: await makeBook(rows, omitEquipment),
              }),
              200,
            )
          ).json();
        const row = [
          today,
          "7799999",
          "Смесь для проверки",
          100,
          150,
          125,
          124,
          "",
        ];
        const plan = await preview([row, row]);
        assert.equal(plan.errorCount, 0);
        assert.equal(plan.added, 2);
        await expect(
          send("/records/import/confirm", "POST", { id: plan.id }, key),
          200,
        );
        let saved = (
          await (
            await expect(
              send("/records?search=7799999", "GET", undefined, key),
              200,
            )
          ).json()
        ).records;
        assert.equal(saved.length, 2);
        assert.notEqual(saved[0].id, saved[1].id);
        const repeat = await preview([row]);
        assert.equal(repeat.added, 1);
        assert.equal(repeat.updated, 0);
        await expect(
          send("/records/import/confirm", "POST", { id: repeat.id }, key),
          200,
        );
        const updateRow: any[] = [...row];
        updateRow[5] = 130;
        updateRow[6] = null;
        const update = await preview([[...updateRow, saved[0].id]], true);
        assert.equal(update.errorCount, 0, JSON.stringify(update.errors));
        assert.equal(update.updated, 1);
        await expect(
          send("/records/import/confirm", "POST", { id: update.id }, key),
          200,
        );
        saved = (
          await (
            await expect(
              send("/records?search=7799999", "GET", undefined, key),
              200,
            )
          ).json()
        ).records;
        assert.equal(saved.length, 3);
        assert.equal(saved.filter((r: any) => r.actual === 130).length, 1);
        assert.equal(saved.find((r: any) => r.actual === 130).equipment, 124);
        const duplicateId = await preview([
          [...row, saved[0].id],
          [...row, saved[0].id],
        ]);
        assert.equal(duplicateId.errorCount, 2);
        const invalid = await preview([[...row, "not-a-guid"]]);
        assert.equal(invalid.errorCount, 1);
        const missing = await preview([
          [...row, "11111111-1111-4111-8111-111111111111"],
        ]);
        assert.equal(missing.errorCount, 1);
        const before = await preview([[...row, saved[0].id]]);
        await expect(
          send(
            "/records/" + saved[0].id,
            "PUT",
            { ...input("7799999", 126, 124), version: saved[0].version },
            admin,
          ),
          200,
        );
        await expect(
          send("/records/import/confirm", "POST", { id: before.id }, key),
          409,
        );
        const exportResponse = await expect(
          send("/records/export?search=7799999", "GET", undefined, key),
          200,
        );
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(
          Buffer.from(await exportResponse.arrayBuffer()) as any,
        );
        assert.equal(
          book.worksheets[0].getRow(1).getCell(9).text,
          "ID измерения",
        );
        assert.equal(book.worksheets[0].rowCount, 4);
      },
    );
    await t.test(
      "Экспорт → импорт и восстановление архива с отсутствующими ID",
      async () => {
        const m = await (
          await expect(
            send(
              "/mixtures",
              "POST",
              {
                name: "Архив Excel roundtrip",
                tMin: 10,
                tMax: 30,
              },
              admin,
            ),
            201,
          )
        ).json();
        const originals: Measurement[] = [];
        for (const actual of [20, 35]) {
          originals.push(
            await (
              await expect(
                send(
                  "/records",
                  "POST",
                  {
                    sup: "0098100",
                    mixtureId: m.id,
                    actual,
                    equipment: 20,
                  },
                  employee,
                ),
                201,
              )
            ).json(),
          );
        }
        await pool.query(
          "UPDATE dbo.measurements SET date=$1 WHERE mixture_id=$2",
          [oldDay, m.id],
        );
        const downloaded = Buffer.from(
          await (
            await expect(
              send(
                "/records/export?mixtureId=" +
                  m.id +
                  "&from=" +
                  oldDay +
                  "&to=" +
                  oldDay,
                "GET",
                undefined,
                key,
              ),
              200,
            )
          ).arrayBuffer(),
        );
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(downloaded as any);
        assert.equal(book.worksheets[0].rowCount, 3);
        assert.equal(book.worksheets[0].getRow(2).getCell(2).value, "0098100");
        const upload = async (
          bytes = downloaded,
          mode = "standard",
          token = key,
        ) =>
          (
            await expect(
              fetch(base + "/records/import/preview?mode=" + mode, {
                method: "POST",
                headers: { Cookie: token, "Content-Type": workbookType },
                body: bytes,
              }),
              token === employee ? 403 : 200,
            )
          ).json();
        const commit = (id: string) =>
          expect(send("/records/import/confirm", "POST", { id }, key), 200);
        const read = async () =>
          (
            await (
              await expect(
                send("/records?mixtureId=" + m.id, "GET", undefined, key),
                200,
              )
            ).json()
          ).records as Measurement[];
        const roundtrip = await upload();
        assert.equal(roundtrip.errorCount, 0, JSON.stringify(roundtrip.errors));
        assert.equal(roundtrip.updated, 2);
        assert.equal(roundtrip.added, 0);
        await commit(roundtrip.id);
        const before = await read();
        assert.equal(before.length, 2);
        for (const r of before) {
          assert.equal(r.sup, "0098100");
          assert.equal(r.date, oldDay);
          assert.equal(r.equipment, 20);
          assert.equal(r.status, r.actual === 20 ? "OK" : "NOK");
          await expect(
            send(
              "/records/" + r.id + "?version=" + r.version,
              "DELETE",
              undefined,
              key,
            ),
            204,
          );
        }
        const missing = await upload();
        assert.equal(missing.errorCount, 2);
        assert.match(missing.errors[0].message, /Перенос.*восстановление/);
        assert.equal((await read()).length, 0);
        const restored = await upload(downloaded, "restore");
        assert.equal(restored.errorCount, 0, JSON.stringify(restored.errors));
        assert.equal(restored.added, 2);
        await commit(restored.id);
        const after = await read();
        assert.deepEqual(
          after.map((r) => r.id).sort(),
          before.map((r) => r.id).sort(),
        );
        for (const r of after) {
          const old = before.find((o) => o.id === r.id)!;
          for (const field of [
            "date",
            "sup",
            "mixtureId",
            "tMin",
            "tMax",
            "actual",
            "equipment",
            "status",
          ] as const)
            assert.equal(r[field], old[field], field);
        }
        const repeat = await upload(downloaded, "restore");
        assert.equal(repeat.added, 0);
        assert.equal(repeat.updated, 2);
        await commit(repeat.id);
        assert.equal((await read()).length, 2);
        const equipmentOnly = new ExcelJS.Workbook();
        await equipmentOnly.xlsx.load(downloaded as any);
        equipmentOnly.worksheets[0].getRow(2).getCell(6).value = 20;
        equipmentOnly.worksheets[0].getRow(2).getCell(7).value = 35;
        equipmentOnly.worksheets[0].getRow(2).getCell(8).value = "OK";
        const recalculated = await upload(
          Buffer.from(await equipmentOnly.xlsx.writeBuffer()),
          "restore",
        );
        assert.equal(recalculated.errorCount, 0);
        assert.equal(recalculated.rows[0].status, "NOK");
        const invalid = new ExcelJS.Workbook();
        await invalid.xlsx.load(downloaded as any);
        invalid.worksheets[0].getRow(2).getCell(9).value = "bad-id";
        const bad = await upload(
          Buffer.from(await invalid.xlsx.writeBuffer()),
          "restore",
        );
        assert.equal(bad.errorCount, 1);
        assert.equal(bad.id, undefined);
        const duplicate = new ExcelJS.Workbook();
        await duplicate.xlsx.load(downloaded as any);
        duplicate.worksheets[0].getRow(3).getCell(9).value =
          duplicate.worksheets[0].getRow(2).getCell(9).value;
        assert.equal(
          (
            await upload(
              Buffer.from(await duplicate.xlsx.writeBuffer()),
              "restore",
            )
          ).errorCount,
          2,
        );
        await upload(downloaded, "restore", employee);
        const pending = await upload(downloaded, "restore");
        const row = (await read())[0];
        await expect(
          send(
            "/records/" + row.id,
            "PUT",
            {
              sup: row.sup,
              mixtureId: row.mixtureId,
              actual: 22,
              equipment: 20,
              version: row.version,
            },
            admin,
          ),
          200,
        );
        await expect(
          send("/records/import/confirm", "POST", { id: pending.id }, key),
          409,
        );
        const audits = (
          await pool.query(
            "SELECT details FROM dbo.audit_log WHERE action='import.row.create' AND entity_id=$1",
            [row.id],
          )
        ).rows;
        assert.ok(
          audits.some(
            (a) =>
              a.details.mode === "restore" && a.details.restoredId === row.id,
          ),
        );
      },
    );

    await t.test(
      "Исправленная дельта скрывает корректировку, удалённое измерение сохраняет историю",
      async () => {
        const baseline = (
          await (
            await expect(
              send("/corrections/summary", "GET", undefined, key),
              200,
            )
          ).json()
        ).active;
        let r = await (
          await expect(
            send("/records", "POST", input("0098200", 125, 120), employee),
            201,
          )
        ).json();
        const listing = async (view = "active") =>
          await (
            await expect(
              send(
                "/corrections?search=0098200&view=" + view,
                "GET",
                undefined,
                key,
              ),
              200,
            )
          ).json();
        const summary = async () =>
          (
            await (
              await expect(
                send("/corrections/summary", "GET", undefined, key),
                200,
              )
            ).json()
          ).active;
        const edit = async (actual: number) => {
          r = await (
            await expect(
              send(
                "/records/" + r.id,
                "PUT",
                { ...input("0098200", actual, 120), version: r.version },
                admin,
              ),
              200,
            )
          ).json();
        };
        const first = (await listing()).rows[0];
        assert.ok(first);
        assert.equal(await summary(), baseline + 1);
        await edit(123);
        assert.equal((await listing()).total, 0);
        assert.equal(await summary(), baseline);
        assert.equal(
          (
            await pool.query(
              "SELECT id FROM dbo.corrective_actions WHERE id=$1",
              [first.id],
            )
          ).rowCount,
          1,
        );
        await edit(120);
        assert.equal((await listing()).total, 0);
        await edit(124);
        assert.equal((await listing()).rows[0].id, first.id);
        const task = (await listing()).rows[0];
        await expect(
          send(
            "/corrections/" + task.id,
            "PUT",
            {
              status: "DONE",
              responsibleId: null,
              workDone: "Проверено",
              version: task.version,
            },
            key,
          ),
          200,
        );
        assert.equal((await listing("archive")).total, 1);
        await edit(122);
        assert.equal((await listing("archive")).total, 0);
        const exported = await expect(
          send(
            "/corrections/export?search=0098200&view=archive",
            "GET",
            undefined,
            key,
          ),
          200,
        );
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(await exported.arrayBuffer()) as any);
        assert.equal(wb.worksheets[0].rowCount, 1);
        await expect(
          send(
            "/records/" + r.id + "?version=" + r.version,
            "DELETE",
            undefined,
            key,
          ),
          204,
        );
        const retained = (await listing("archive")).rows[0];
        assert.equal(retained.id, first.id);
        assert.equal(retained.sourceDeleted, true);
        assert.equal(retained.workDone, "Проверено");
        assert.equal(await summary(), baseline);
        const history = await (
          await expect(
            send(
              "/corrections/" + first.id + "/history",
              "GET",
              undefined,
              key,
            ),
            200,
          )
        ).json();
        assert.ok(
          history.events.some((e: any) => e.kind === "measurement_changed"),
        );
        assert.ok(
          history.events.some((e: any) => e.kind === "measurement_deleted"),
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

    await t.test(
      "Линии MB/FMF: алфавит, регистр, страницы, Excel и удаление",
      async () => {
        const names = [
          "M1-line",
          "m2-line",
          "М1-line",
          "м2-line",
          " m1-space",
          "M3-line",
          "FMF-line",
          "XM1-line",
        ];
        const mbSups = new Set([
          "8800000",
          "8800001",
          "8800002",
          "8800003",
          "8800004",
        ]);
        for (const [i, name] of names.entries()) {
          const mixture = await (
            await expect(
              send(
                "/mixtures",
                "POST",
                {
                  name,
                  tMin: 100,
                  tMax: 150,
                },
                admin,
              ),
              201,
            )
          ).json();
          await expect(
            send(
              "/records",
              "POST",
              {
                sup: String(8800000 + i),
                mixtureId: mixture.id,
                actual: 125,
                equipment: 125,
              },
              admin,
            ),
            201,
          );
        }
        const page = await (
          await expect(
            send(
              "/records?search=880000&line=MB&size=2",
              "GET",
              undefined,
              admin,
            ),
            200,
          )
        ).json();
        assert.equal(page.total, 5);
        assert.equal(page.records.length, 2);
        assert.ok(page.records.every((r: any) => mbSups.has(r.sup)));
        const fmf = await (
          await expect(
            send("/records?search=880000&line=FMF", "GET", undefined, admin),
            200,
          )
        ).json();
        assert.equal(fmf.total, 3);
        assert.ok(fmf.records.every((r: any) => !mbSups.has(r.sup)));
        await expect(send("/records?line=BAD", "GET", undefined, admin), 400);
        const response = await expect(
          send(
            "/records/export?search=880000&line=MB",
            "GET",
            undefined,
            admin,
          ),
          200,
        );
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(Buffer.from(await response.arrayBuffer()) as any);
        assert.equal(book.worksheets[0].actualRowCount, 6);
        const preview = await (
          await expect(
            send(
              "/records/delete-preview?search=880000&line=MB",
              "GET",
              undefined,
              admin,
            ),
            200,
          )
        ).json();
        assert.equal(preview.count, 5);
        await expect(
          send(
            "/records/by-filter",
            "DELETE",
            {
              filters: { search: "880000", line: "MB" },
              fingerprint: preview.fingerprint,
            },
            admin,
          ),
          200,
        );
        const remaining = await (
          await expect(
            send("/records?search=880000", "GET", undefined, admin),
            200,
          )
        ).json();
        assert.equal(remaining.total, 3);
        assert.ok(remaining.records.every((r: any) => !mbSups.has(r.sup)));
      },
    );

    await t.test(
      "Лимиты смеси обновляют все измерения, OK/NOK, отчёты и аудит",
      async () => {
        const createMixture = async (name: string, min: number, max: number) =>
          (
            await (
              await expect(
                send(
                  "/mixtures",
                  "POST",
                  { name, tMin: min, tMax: max },
                  admin,
                ),
                201,
              )
            ).json()
          ).id;
        const normA = await createMixture("Нормативы A", 10, 30);
        const normB = await createMixture("Нормативы B", 0, 100);
        const created: Measurement[] = [];
        for (const [sup, actual, equipment] of [
          ["9911001", 20, 21],
          ["9911001", 29, 29],
          ["9911002", 35, 29],
        ] as const)
          created.push(
            await (
              await expect(
                send(
                  "/records",
                  "POST",
                  { sup, mixtureId: normA, actual, equipment },
                  admin,
                ),
                201,
              )
            ).json(),
          );
        const unrelated = await (
          await expect(
            send(
              "/records",
              "POST",
              { sup: "9911003", mixtureId: normB, actual: 20, equipment: 20 },
              admin,
            ),
            201,
          )
        ).json();
        await pool.query(
          "UPDATE dbo.measurements SET date=$1 WHERE mixture_id=$2 OR mixture_id=$3",
          [oldDay, normA, normB],
        );
        const list = async (id = normA) =>
          (
            await (
              await expect(
                send("/records?mixtureId=" + id, "GET", undefined, admin),
                200,
              )
            ).json()
          ).records;
        const report = async () =>
          await (
            await expect(
              send("/reports?date=" + oldDay, "GET", undefined, admin),
              200,
            )
          ).json();
        const update = (min: number, max: number) =>
          expect(
            send(
              "/mixtures/" + normA,
              "PUT",
              { name: "Нормативы A", tMin: min, tMax: max },
              admin,
            ),
            200,
          );
        // Imported historical SUPs may predate the seven-digit rule.
        await pool.query(
          "ALTER TABLE dbo.measurements NOCHECK CONSTRAINT measurements_sup_seven_digits; UPDATE dbo.measurements SET sup=N'LEGACY-NORMS' WHERE id=$1; ALTER TABLE dbo.measurements WITH NOCHECK CHECK CONSTRAINT measurements_sup_seven_digits;",
          [created[1].id],
        );
        const before = await list(),
          otherBefore = await list(normB),
          reportBefore = await report();
        const correction = (
          await (
            await expect(
              send("/corrections?search=9911002", "GET", undefined, admin),
              200,
            )
          ).json()
        ).rows[0];
        const revisionBefore = (
          await pool.query(
            "SELECT revision FROM dbo.change_revision WHERE topic='measurements'",
          )
        ).rows[0].revision;
        await update(22, 28);
        let rows = await list();
        assert.equal(rows.length, 3);
        assert.ok(
          rows.every(
            (r: any) => r.tMin === 22 && r.tMax === 28 && r.status === "NOK",
          ),
        );
        for (const r of rows) {
          const old = before.find((o: any) => o.id === r.id);
          assert.deepEqual(
            [r.actual, r.equipment, r.date, r.createdBy, r.sup],
            [old.actual, old.equipment, old.date, old.createdBy, old.sup],
          );
          assert.equal(r.version, old.version + 1);
        }
        assert.deepEqual(await list(normB), otherBefore);
        assert.notEqual(
          (
            await pool.query(
              "SELECT revision FROM dbo.change_revision WHERE topic='measurements'",
            )
          ).rows[0].revision,
          revisionBefore,
        );
        const changedReport = await report();
        assert.equal(changedReport.total, reportBefore.total);
        assert.equal(changedReport.ok, reportBefore.ok - 2);
        assert.equal(changedReport.nok, reportBefore.nok + 2);
        assert.ok(changedReport.version > reportBefore.version);
        assert.ok(
          changedReport.rows
            .filter((r: any) => created.some((c) => c.id === r.id))
            .every((r: any) => r.tMin === 22 && r.tMax === 28),
        );
        await expect(
          send(
            "/records/" + created[0].id,
            "PUT",
            {
              sup: "9911001",
              mixtureId: normA,
              actual: 20,
              equipment: 21,
              version: created[0].version,
            },
            admin,
          ),
          409,
        );
        const auditRows = (
          await pool.query(
            "SELECT actor_id,before_data,after_data,details FROM dbo.audit_log WHERE action='record.norms_updated' AND entity_id IN(SELECT LOWER(CONVERT(varchar(36),id)) FROM dbo.measurements WHERE mixture_id=$1)",
            [normA],
          )
        ).rows;
        assert.equal(auditRows.length, 3);
        assert.ok(
          auditRows.every(
            (a: any) =>
              a.actor_id === adminUser.id &&
              a.before_data.tMin === 10 &&
              a.after_data.tMin === 22 &&
              a.details.mixtureId === normA,
          ),
        );
        await update(0, 40);
        rows = await list();
        assert.ok(
          rows.every(
            (r: any) => r.status === "OK" && r.tMin === 0 && r.tMax === 40,
          ),
        );
        const expanded = await report();
        assert.equal(expanded.ok, reportBefore.ok + 1);
        assert.equal(expanded.nok, reportBefore.nok - 1);
        const correctionAfter = (
          await (
            await expect(
              send("/corrections/" + correction.id, "GET", undefined, admin),
              200,
            )
          ).json()
        ).correction;
        assert.deepEqual(correctionAfter, correction);
        const versions = rows.map((r: any) => [r.id, r.version]);
        await update(0, 40);
        assert.deepEqual(
          (await list()).map((r: any) => [r.id, r.version]),
          versions,
        );
        const normKey = cookie(
          await expect(sign("newprimary", "fresh-pass"), 200),
        );
        await expect(
          send(
            "/corrections/" + correction.id + "?version=" + correction.version,
            "DELETE",
            undefined,
            normKey,
          ),
          204,
        );
        await update(0, 40);
        await expect(
          send("/corrections/" + correction.id, "GET", undefined, normKey),
          404,
        );
        assert.equal(
          (
            await (
              await expect(
                send("/corrections?search=9911002", "GET", undefined, normKey),
                200,
              )
            ).json()
          ).total,
          0,
        );
        const activeEmployee = cookie(await expect(sign("employee_1"), 200));
        await expect(
          send(
            "/mixtures/" + normA,
            "PUT",
            { name: "Нормативы A", tMin: 50, tMax: 10 },
            admin,
          ),
          400,
        );
        assert.deepEqual(
          (await list()).map((r: any) => [r.id, r.version]),
          versions,
        );
        const wb = new ExcelJS.Workbook(),
          ws = wb.addWorksheet("Смеси");
        ws.addRow(["Название смеси", "T min", "T max"]);
        ws.addRow(["Нормативы A", 15, 25]);
        const preview = await (
          await expect(
            fetch(base + "/mixtures/import/preview", {
              method: "POST",
              headers: { Cookie: admin, "Content-Type": workbookType },
              body: Buffer.from(await wb.xlsx.writeBuffer()),
            }),
            200,
          )
        ).json();
        assert.equal(preview.errorCount, 0);
        await expect(
          send("/mixtures/import/confirm", "POST", { id: preview.id }, admin),
          200,
        );
        rows = await list();
        assert.ok(rows.every((r: any) => r.tMin === 15 && r.tMax === 25));
        assert.equal(
          rows.find((r: any) => r.id === created[0].id).status,
          "OK",
        );
        assert.equal(
          rows.find((r: any) => r.id === created[1].id).status,
          "NOK",
        );
        await pool.query(
          "UPDATE dbo.mixtures SET t_min=10,t_max=50 WHERE id=$1",
          [normA],
        );
        assert.ok(
          (await list()).every(
            (r: any) => r.status === "OK" && r.tMin === 10 && r.tMax === 50,
          ),
        );
        // Simulate upgrading an existing database whose historical snapshots differ.
        await pool.query(
          "UPDATE dbo.measurements SET t_min=0,t_max=5 WHERE id=$1",
          [created[0].id],
        );
        await pool.query("DELETE FROM dbo.schema_migrations WHERE version=7");
        await run("server/migrate.ts");
        rows = await list();
        assert.ok(
          rows.every(
            (r: any) => r.tMin === 10 && r.tMax === 50 && r.status === "OK",
          ),
        );
        assert.deepEqual(
          [
            rows.find((r: any) => r.id === created[0].id).actual,
            rows.find((r: any) => r.id === created[0].id).equipment,
          ],
          [20, 21],
        );
        // Multi-row SQL edits must synchronize both mixtures without touching others.
        const untouched = (
          await pool.query(
            "SELECT id,t_min,t_max,actual,equipment,version FROM dbo.measurements WHERE mixture_id=$1 ORDER BY id",
            [mix],
          )
        ).rows;
        await pool.query(
          "UPDATE dbo.mixtures SET t_min=30,t_max=60 WHERE id=$1 OR id=$2",
          [normA, normB],
        );
        assert.ok(
          (await list()).every(
            (r: any) => r.tMin === 30 && r.tMax === 60 && r.status === "NOK",
          ),
        );
        const otherAfter = await list(normB);
        assert.equal(otherAfter[0].id, unrelated.id);
        assert.equal(otherAfter[0].status, "NOK");
        assert.deepEqual(
          (
            await pool.query(
              "SELECT id,t_min,t_max,actual,equipment,version FROM dbo.measurements WHERE mixture_id=$1 ORDER BY id",
              [mix],
            )
          ).rows,
          untouched,
        );
        await expect(
          send(
            "/mixtures/" + normA,
            "PUT",
            { name: "Нормативы A", tMin: 0, tMax: 40 },
            activeEmployee,
          ),
          403,
        );
      },
    );

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
