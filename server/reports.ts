import { z } from "zod";
import { countsSql, lock, moscowDateSql, type DbClient } from "./db.js";
import { transaction, audit } from "./audit.js";
import { fail } from "./repository.js";
import type { ReportRow } from "../shared/workflow.js";
const clockSql =
  "SELECT " +
  moscowDateSql +
  " AS today,DATEADD(day,-1," +
  moscowDateSql +
  ") AS yesterday";
const shiftDate = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
function deviation(r: any) {
  const parts: string[] = [];
  for (const [key, title] of [
    ["actual", "T(fact)"],
    ["equipment", "T(обор)"],
  ]) {
    const n = r[key];
    if (n !== null && n < r.t_min)
      parts.push(
        title +
          " ниже на " +
          Number((r.t_min - n).toFixed(6)).toLocaleString("ru-RU") +
          " °C",
      );
    else if (n !== null && n > r.t_max)
      parts.push(
        title +
          " выше на " +
          Number((n - r.t_max).toFixed(6)).toLocaleString("ru-RU") +
          " °C",
      );
  }
  return (
    parts.join("; ") ||
    (r.legacy_pending
      ? "Историческая пара температур; требуется согласование переноса"
      : "Отклонение не определено")
  );
}
async function rebuild(c: DbClient, date: string, tryLock = false) {
  if (!(await lock(c, "report:" + date, "Exclusive", tryLock ? 0 : 15000)))
    return false;
  const old = (
    await c.query("SELECT * FROM daily_reports WHERE date=$1", [date])
  ).rows[0];
  if (
    old &&
    !(await c.query("SELECT 1 FROM report_dirty_days WHERE date=$1", [date]))
      .rowCount
  )
    return true;
  const stats = (
    await c.query(
      "SELECT " + countsSql + " FROM dbo.measurements WHERE date=$1",
      [date],
    )
  ).rows[0];
  const nokPercent = stats.total
    ? Number(((stats.nok / stats.total) * 100).toFixed(2))
    : 0;
  const rows = (
    await c.query(
      "SELECT date,id,sup,mixture_name,t_min,t_max,actual,equipment,legacy_pending FROM dbo.measurements WHERE date=$1 AND status='NOK' ORDER BY sup,id",
      [date],
    )
  ).rows.map(
    (r) =>
      ({
        id: r.id,
        date: r.date,
        sup: r.sup,
        mixtureName: r.mixture_name,
        tMin: r.t_min,
        tMax: r.t_max,
        actual: r.actual,
        equipment: r.equipment,
        deviation: deviation(r),
      }) satisfies ReportRow,
  );
  if (
    !old ||
    old.total !== stats.total ||
    old.ok !== stats.ok ||
    old.nok !== stats.nok ||
    old.pending !== stats.pending ||
    Number(old.nok_percent) !== nokPercent ||
    JSON.stringify(
      old.nok_rows.map((r: ReportRow) => [
        r.id,
        r.date,
        r.sup,
        r.mixtureName,
        r.tMin,
        r.tMax,
        r.actual,
        r.equipment,
        r.deviation,
      ]),
    ) !==
      JSON.stringify(
        rows.map((r: ReportRow) => [
          r.id,
          r.date,
          r.sup,
          r.mixtureName,
          r.tMin,
          r.tMax,
          r.actual,
          r.equipment,
          r.deviation,
        ]),
      )
  ) {
    const saved = (
      await c.query(
        (old
          ? "UPDATE dbo.daily_reports SET total=$2,ok=$3,nok=$4,pending=$5,nok_percent=$6,nok_rows=$7,version=version+1,updated_at=SYSUTCDATETIME() WHERE date=$1"
          : "INSERT INTO dbo.daily_reports(date,total,ok,nok,pending,nok_percent,nok_rows) VALUES($1,$2,$3,$4,$5,$6,$7)") +
          "; SELECT * FROM dbo.daily_reports WHERE date=$1;",
        [
          date,
          stats.total,
          stats.ok,
          stats.nok,
          stats.pending,
          nokPercent,
          JSON.stringify(rows),
        ],
      )
    ).rows[0];
    const summary = (r: any) =>
      r
        ? {
            date,
            total: r.total,
            ok: r.ok,
            nok: r.nok,
            pending: r.pending,
            nokPercent: Number(r.nok_percent),
            version: r.version,
          }
        : null;
    await audit(
      c,
      null,
      old ? "report.updated" : "report.generated",
      "daily_reports",
      date,
      summary(old),
      summary(saved),
    );
  }
  await c.query("DELETE FROM report_dirty_days WHERE date=$1", [date]);
  return true;
}
export async function runReportCycle(asOf?: string) {
  if (asOf) z.iso.date().parse(asOf);
  return transaction(async (c) => {
    if (!(await lock(c, "workflow", "Exclusive", 0))) return;
    const today = asOf ?? ((await c.query(clockSql)).rows[0].today as string);
    const yesterday = shiftDate(today, -1);
    const last =
      (
        await c.query<{ last_day: string | null }>(
          "SELECT last_day FROM dbo.report_scheduler WHERE id=1",
        )
      ).rows[0].last_day ?? shiftDate(today, -2);
    const finish = [shiftDate(last, 31), yesterday].sort()[0];
    const dates = new Set<string>([yesterday]);
    const dirty = await c.query<{ date: string }>(
      "SELECT TOP (100) date FROM dbo.report_dirty_days WHERE date<$1 ORDER BY date",
      [today],
    );
    const missing = await c.query<{ date: string }>(
      "SELECT DISTINCT TOP (100) m.date FROM dbo.measurements m WHERE m.date<$1 AND NOT EXISTS(SELECT 1 FROM dbo.daily_reports r WHERE r.date=m.date) ORDER BY m.date",
      [today],
    );
    for (const { date } of [...dirty.rows, ...missing.rows]) dates.add(date);
    for (
      let date = shiftDate(last, 1);
      date <= finish;
      date = shiftDate(date, 1)
    )
      dates.add(date);
    let skipped = false;
    for (const day of [...dates].sort())
      if (!(await rebuild(c, day, true))) skipped = true;
    if (!skipped)
      await c.query(
        "UPDATE dbo.report_scheduler SET last_day=$1 WHERE id=1 AND (last_day IS NULL OR last_day<$1)",
        [finish],
      );
  });
}
export async function getDailyReport(query: Record<string, unknown>) {
  const input = z
    .object({
      date: z.iso.date().optional(),
      page: z.coerce.number().int().positive().max(1000000).default(1),
    })
    .parse(query);
  return transaction(async (c) => {
    // Serialize report rebuilds with measurement writes across server processes.
    await lock(c, "workflow");
    const { yesterday } = (await c.query(clockSql)).rows[0],
      date = input.date ?? yesterday;
    if (date > yesterday)
      fail(400, "Ежедневный отчёт доступен за завершённые календарные дни");
    await rebuild(c, date);
    const saved = (
      await c.query("SELECT * FROM dbo.daily_reports WHERE date=$1", [date])
    ).rows[0];
    const dates = (
      await c.query(
        "SELECT DISTINCT date FROM dbo.measurements WHERE date<=$1 ORDER BY date DESC",
        [yesterday],
      )
    ).rows.map((r) => r.date);
    return {
      date,
      total: saved.total,
      ok: saved.ok,
      nok: saved.nok,
      pending: saved.pending,
      nokPercent: Number(saved.nok_percent),
      version: saved.version,
      generatedAt: saved.generated_at,
      updatedAt: saved.updated_at,
      rows: saved.nok_rows.slice((input.page - 1) * 15, input.page * 15),
      page: input.page,
      dates,
      maxDate: yesterday,
    };
  });
}
export function startReportScheduler() {
  let stopped = false,
    running: Promise<unknown> | undefined;
  const tick = () => {
    if (!stopped && !running)
      running = runReportCycle()
        .catch((e) =>
          console.error("Не удалось сформировать ежедневный отчёт:", e.message),
        )
        .finally(() => {
          running = undefined;
        });
  };
  tick();
  const timer = setInterval(tick, 60000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
