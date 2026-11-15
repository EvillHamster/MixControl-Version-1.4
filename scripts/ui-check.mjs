// Optional isolated browser QA; never points the app at the working database.
import "dotenv/config";
import assert from "node:assert/strict";
import pg from "pg";
import ExcelJS from "exceljs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const control = new pg.Client({ connectionString: process.env.DATABASE_URL });
const database = "mixcontrol_test_ui_" + randomBytes(6).toString("hex");
const port = 3002;
const base = `http://127.0.0.1:${port}/api`;
await control.connect();
await control.query(
  `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8'`,
);
const url = new URL(process.env.DATABASE_URL);
url.pathname = "/" + database;
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: {
    ...process.env,
    DATABASE_URL: url.toString(),
    PORT: String(port),
    HOST: "127.0.0.1",
    COOKIE_SECURE: "false",
  },
  windowsHide: true,
  stdio: "inherit",
});
let stopped = false;
async function cleanup() {
  if (stopped) return;
  stopped = true;
  server.kill("SIGTERM");
  await new Promise((resolve) =>
    server.exitCode !== null ? resolve() : server.once("exit", resolve),
  );
  await control.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await control.end();
  process.exit(process.exitCode ?? 0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.stdin.on("data", (data) => {
  if (data.toString().trim() === "stop") void cleanup();
});
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    ready = (await fetch(base + "/health")).ok;
  } catch {}
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) {
  await cleanup();
  throw new Error("QA API не запустился");
}
const password = "Ui-check-" + randomBytes(10).toString("hex");
const setup = await fetch(base + "/auth/setup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    login: "ui_keyuser",
    name: "Ключевой пользователь",
    password,
  }),
});
const cookie = setup.headers.get("set-cookie").split(";")[0];
const call = (route, body) =>
  fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
await call("/users", {
  login: "ui_employee",
  name: "Анна · Контроль качества",
  password,
  role: "EMPLOYEE",
});
await call("/users", {
  login: "ui_admin",
  name: "Администратор",
  password,
  role: "ADMIN",
});
const mixtures = [];
for (const [name, tMin, tMax] of [
  ["M1 — T11430", 100, 150],
  ["M2 — T11600", 90, 130],
  ["M3 — T11720", 110, 160],
])
  mixtures.push(
    (await (await call("/mixtures", { name, tMin, tMax })).json()).id,
  );
const login = await fetch(base + "/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ login: "ui_employee", password }),
});
const employeeCookie = login.headers.get("set-cookie").split(";")[0];
for (let i = 0; i < 18; i++)
  await fetch(base + "/records", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: i % 2 ? employeeCookie : cookie,
    },
    body: JSON.stringify({
      sup: String(9933451 + i),
      mixtureId: mixtures[i % 3],
      actual: i % 4 === 0 ? 165 : i % 5 === 0 ? null : 125,
      equipment: 120,
    }),
  });
const wb = new ExcelJS.Workbook(),
  sheet = wb.addWorksheet("Журнал");
sheet.addRow([
  "Дата",
  "SUP",
  "Смесь",
  "T min",
  "T max",
  "T(fact)",
  "T(обор)",
  "Итог",
]);
const moscowDate = (daysAgo) =>
  new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Europe/Moscow",
  });
// Seed through the real journal import: ordinary record creation uses today's date.
const scenarios = [
  {
    date: moscowDate(1),
    temperatures: [
      [125, 123],
      [155, 145],
      [145, 155],
      [null, 125],
      [155, 97],
    ],
    expected: { total: 5, ok: 1, nok: 3, pending: 1, nokPercent: 60 },
  },
  {
    date: moscowDate(3),
    temperatures: [
      [100, 150],
      ...Array.from({ length: 16 }, (_, i) => (i % 2 ? [120, 97] : [153, 130])),
    ],
    expected: { total: 17, ok: 1, nok: 16, pending: 0, nokPercent: 94.12 },
  },
  {
    date: moscowDate(6),
    temperatures: [
      [120, 120],
      [115, 115],
    ],
    expected: { total: 2, ok: 2, nok: 0, pending: 0, nokPercent: 0 },
  },
];
let sup = 9940000;
for (const { date, temperatures } of scenarios)
  for (const [actual, equipment] of temperatures)
    sheet.addRow([
      date,
      String(++sup),
      "M1 — T11430",
      100,
      150,
      actual,
      equipment,
      "",
    ]);

const preview = await fetch(base + "/records/import/preview", {
  method: "POST",
  headers: {
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    Cookie: cookie,
  },
  body: Buffer.from(await wb.xlsx.writeBuffer()),
});
const previewData = await preview.json();
if (!preview.ok || previewData.errors?.length)
  throw new Error(JSON.stringify(previewData));
const confirmed = await call("/records/import/confirm", { id: previewData.id });
if (!confirmed.ok) throw new Error(await confirmed.text());
const getReport = async (query = "") => {
  const response = await fetch(base + "/reports" + query, {
    headers: { Cookie: employeeCookie },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
try {
  const latest = await getReport();
  assert.equal(latest.date, scenarios[0].date);
  assert.deepEqual(
    latest.dates,
    scenarios.map(({ date }) => date),
  );
  assert.ok(latest.rows.some((row) => row.deviation.includes("T(fact)")));
  assert.ok(latest.rows.some((row) => row.deviation.includes("T(обор)")));
  assert.equal(
    latest.rows.find((row) => row.sup === "9940005")?.deviation,
    "T(fact) выше на 5 °C; T(обор) ниже на 3 °C",
  );
  for (const { date, expected } of scenarios) {
    const report = await getReport("?date=" + date);
    for (const [key, value] of Object.entries(expected))
      assert.equal(report[key], value, date + ": " + key);
    assert.equal(report.rows.length, Math.min(15, expected.nok));
    const again = await getReport("?date=" + date);
    assert.equal(again.version, report.version);
  }
  const second = await getReport("?date=" + scenarios[1].date + "&page=2");
  assert.equal(second.rows.length, 1);
  const gap = await getReport("?date=" + moscowDate(2));
  assert.equal(gap.total, 0);
  assert.ok(!gap.dates.includes(gap.date));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await cleanup();
}
console.table(scenarios.map(({ date, expected }) => ({ date, ...expected })));
console.log(
  JSON.stringify({
    url: `http://localhost:${port}`,
    keyuser: "ui_keyuser",
    admin: "ui_admin",
    employee: "ui_employee",
    password,
    note: "Disposable synthetic QA accounts only. Working database unchanged. Type stop to clean up.",
  }),
);
setInterval(() => {}, 60000);
