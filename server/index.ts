import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { pool } from "./db.js";
import { migrate } from "./migrate.js";
import {
  databaseIdSchema,
  mixtureSchema,
  recordSchema,
  employeeRecordSchema,
} from "../shared/domain.js";
import { mixtureRepository, recordRepository } from "./repository.js";
import { previewImport, confirmImport, mixtureWorkbook } from "./imports.js";
import { measurementWorkbook } from "./excel.js";
import {
  authService,
  requireAuth,
  requireAdmin,
  requireUserManager,
  currentUser,
} from "./auth.js";
import { startEvents, stopEvents, changeStream } from "./events.js";
import { correctionRepository } from "./corrections.js";
import { getDailyReport, startReportScheduler } from "./reports.js";
const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  }),
);
app.use(express.json({ limit: "64kb" }));
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api", (req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    let host;
    try {
      host = new URL(req.headers.origin).host;
    } catch {
      return res.status(403).json({ message: "Недопустимый источник запроса" });
    }
    if (host !== req.headers.host)
      return res.status(403).json({ message: "Недопустимый источник запроса" });
  }
  next();
});
app.get("/api/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
});
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Слишком много попыток входа. Повторите позже." },
});
app.get("/api/auth/status", async (_req, res) =>
  res.json(await authService.status()),
);
app.post("/api/auth/setup", loginLimit, async (req, res) =>
  res.status(201).json(await authService.setup(req.body, res)),
);
app.post("/api/auth/login", loginLimit, async (req, res) =>
  res.json(await authService.login(req.body, res)),
);
app.post("/api/auth/logout", async (req, res) => {
  await authService.logout(req, res);
  res.status(204).end();
});
app.use("/api", requireAuth);
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 300,
    keyGenerator: (_req, res) => currentUser(res).id,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message: "Слишком много запросов. Повторите через минуту." },
  }),
);
app.get("/api/auth/me", (_req, res) => res.json(currentUser(res)));
const credentialLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (_req, res) => currentUser(res).id,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Слишком много попыток смены данных. Повторите позже." },
});
app.put(
  "/api/auth/credentials",
  (_req, res, next) => {
    if (currentUser(res).role !== "KEYUSER") {
      res.status(403).json({ message: "Настройки доступны только KEYUSER" });
      return;
    }
    next();
  },
  credentialLimit,
  async (req, res) => {
    await authService.changeOwnCredentials(req, res);
    res.status(204).end();
  },
);
app.get("/api/events", changeStream);
app.get("/api/users", requireUserManager, async (_req, res) =>
  res.json(await authService.listUsers()),
);
app.put("/api/users/:id/role", requireUserManager, async (req, res) =>
  res.json(
    await authService.assignRole(
      databaseIdSchema.parse(req.params.id),
      req.body,
      currentUser(res),
    ),
  ),
);
app.post("/api/users", requireAdmin, async (req, res) =>
  res
    .status(201)
    .json(await authService.createUser(req.body, currentUser(res))),
);
app.put("/api/users/:id", requireAdmin, async (req, res) =>
  res.json(
    await authService.updateUser(
      databaseIdSchema.parse(req.params.id),
      req.body,
      currentUser(res),
    ),
  ),
);
app.delete("/api/users/:id", requireUserManager, async (req, res) => {
  await authService.deleteUser(
    databaseIdSchema.parse(req.params.id),
    z.coerce.number().int().positive().parse(req.query.version),
    currentUser(res),
  );
  res.status(204).end();
});
app.get("/api/mixtures/options", async (_req, res) => {
  const mixtures = await mixtureRepository.list(false);
  res.json(
    mixtures.map((m) => ({ ...m, tMin: null, tMax: null, recordCount: 0 })),
  );
});
app.get("/api/mixtures", requireAdmin, async (_req, res) =>
  res.json(await mixtureRepository.list(true)),
);
for (const kind of ["records", "mixtures"] as const) {
  app.post(
    "/api/" + kind + "/import/preview",
    requireAdmin,
    express.raw({
      type: [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/octet-stream",
      ],
      limit: "5mb",
    }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body))
        return res.status(400).json({ message: "Выберите файл Excel (.xlsx)" });
      const mode = z
        .enum(["standard", "restore"])
        .default("standard")
        .parse(req.query.mode);
      if (kind !== "records" && mode !== "standard")
        return res
          .status(400)
          .json({
            message: "Режим восстановления доступен только для журнала",
          });
      res.json(await previewImport(req.body, kind, currentUser(res), mode));
    },
  );
  app.post(
    "/api/" + kind + "/import/confirm",
    requireAdmin,
    async (req, res) => {
      res.json(
        await confirmImport(
          databaseIdSchema.parse(req.body?.id),
          kind,
          currentUser(res),
        ),
      );
    },
  );
}
app.get("/api/mixtures/export", requireAdmin, async (_req, res) => {
  const workbook = await mixtureWorkbook();
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.attachment("mixcontrol-mixtures.xlsx");
  await workbook.xlsx.write(res);
  res.end();
});
app.post("/api/mixtures", requireAdmin, async (req, res) =>
  res
    .status(201)
    .json(
      await mixtureRepository.create(
        mixtureSchema.parse(req.body),
        currentUser(res),
      ),
    ),
);
app.put("/api/mixtures/:id", requireAdmin, async (req, res) =>
  res.json(
    await mixtureRepository.update(
      databaseIdSchema.parse(req.params.id),
      mixtureSchema.parse(req.body),
      currentUser(res),
    ),
  ),
);
app.delete("/api/mixtures/:id", requireAdmin, async (req, res) => {
  await mixtureRepository.delete(
    databaseIdSchema.parse(req.params.id),
    currentUser(res),
  );
  res.status(204).end();
});
app.get("/api/records/delete-preview", requireAdmin, async (req, res) => {
  res.json(await recordRepository.previewDeletion(req.query, currentUser(res)));
});
app.delete("/api/records/by-filter", requireAdmin, async (req, res) => {
  const body = z
    .object({
      filters: z.record(z.string(), z.unknown()),
      fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
    })
    .strict()
    .parse(req.body);
  res.json(
    await recordRepository.deleteFiltered(
      body.filters,
      body.fingerprint,
      currentUser(res),
    ),
  );
});
app.get("/api/records/export", requireAdmin, async (req, res) => {
  const workbook = measurementWorkbook(
    await recordRepository.export(req.query),
  );
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="mixcontrol.xlsx"',
  );
  await workbook.xlsx.write(res);
  res.end();
});
app.get("/api/records", async (req, res) =>
  res.json(await recordRepository.list(req.query)),
);
app.post("/api/records", async (req, res) =>
  res
    .status(201)
    .json(
      await recordRepository.save(
        null,
        recordSchema.parse(req.body),
        currentUser(res),
      ),
    ),
);
app.put("/api/records/:id", async (req, res) =>
  res.json(
    await recordRepository.save(
      databaseIdSchema.parse(req.params.id),
      (currentUser(res).role === "EMPLOYEE"
        ? employeeRecordSchema
        : recordSchema
      ).parse(req.body),
      currentUser(res),
    ),
  ),
);
app.delete("/api/records/:id", requireAdmin, async (req, res) => {
  await recordRepository.delete(
    databaseIdSchema.parse(req.params.id),
    z.coerce.number().int().positive().parse(req.query.version),
    currentUser(res),
  );
  res.status(204).end();
});
app.get("/api/reports", async (req, res) =>
  res.json(await getDailyReport(req.query)),
);
app.get("/api/corrections/summary", requireAdmin, async (_req, res) =>
  res.json(await correctionRepository.summary()),
);
app.get("/api/corrections/:id/history", requireAdmin, async (req, res) =>
  res.json(
    await correctionRepository.detail(
      databaseIdSchema.parse(req.params.id),
      req.query,
    ),
  ),
);
app.get("/api/corrections/assignees", requireAdmin, async (_req, res) =>
  res.json(await correctionRepository.assignees()),
);
app.get("/api/corrections/export", requireAdmin, async (req, res) => {
  const book = await correctionRepository.workbook(req.query);
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.attachment("mixcontrol-corrections.xlsx");
  await book.xlsx.write(res);
  res.end();
});
app.get("/api/corrections", requireAdmin, async (req, res) =>
  res.json(await correctionRepository.list(req.query)),
);
app.get("/api/corrections/:id", requireAdmin, async (req, res) =>
  res.json(
    await correctionRepository.detail(
      databaseIdSchema.parse(req.params.id),
      req.query,
    ),
  ),
);
app.put("/api/corrections/:id", requireAdmin, async (req, res) =>
  res.json(
    await correctionRepository.update(
      databaseIdSchema.parse(req.params.id),
      req.body,
      currentUser(res),
    ),
  ),
);
app.delete("/api/corrections/:id", requireAdmin, async (req, res) => {
  await correctionRepository.delete(
    databaseIdSchema.parse(req.params.id),
    z.coerce.number().int().positive().parse(req.query.version),
    currentUser(res),
  );
  res.status(204).end();
});
app.post("/api/corrections/:id/comments", requireAdmin, (_req, res) =>
  res.status(410).json({
    message:
      "Создание комментариев отключено. Используйте поле «Что было сделано».",
  }),
);

app.use("/api", (_req, res) =>
  res.status(404).json({ message: "Метод API не найден" }),
);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
app.use(express.static(root));
app.get("/{*path}", (_req, res) => res.sendFile(path.join(root, "index.html")));
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(error.message);
    if (res.headersSent) {
      res.end();
      return;
    }
    const unique = [2601, 2627].includes(error.number);
    const referenced =
      error.number === 547 && /REFERENCE|FOREIGN KEY/i.test(error.message);
    const invalid = error.number === 547 && !referenced;
    const names = (name: string) => error.message.includes(name);
    const code =
      error instanceof z.ZodError
        ? 400
        : unique
          ? 409
          : referenced
            ? 409
            : invalid
              ? 400
              : (error.status ?? 503);
    res.status(code).json({
      message:
        error instanceof z.ZodError
          ? error.issues.map((x) => x.message).join(". ")
          : unique
            ? names("users_single_keyuser")
              ? "В системе уже есть KEYUSER. Эта роль может быть только у одного пользователя."
              : names("users_login_unique")
                ? "Такой логин уже существует"
                : "Запись с такими уникальными данными уже существует."
            : referenced
              ? "Смесь используется в журнале. Архивируйте её вместо удаления."
              : invalid
                ? names("measurements_sup_seven_digits")
                  ? "SUP должен содержать ровно 7 цифр"
                  : "Некорректные значения температур"
                : error.status
                  ? error.message
                  : "Сервис временно недоступен. Проверьте подключение к базе данных.",
    });
  },
);
await migrate();
await startEvents();
const stopReportScheduler = startReportScheduler();
const sessionCleanup = setInterval(
  () =>
    void pool
      .query(
        "DELETE FROM sessions WHERE expires_at<SYSUTCDATETIME(); DELETE FROM import_jobs WHERE expires_at<SYSUTCDATETIME()",
      )
      .catch((e) => console.error(e.message)),
  60 * 60 * 1000,
);
sessionCleanup.unref();
const server = app.listen(
  Number(process.env.PORT ?? 3001),
  process.env.HOST ?? "127.0.0.1",
  () =>
    console.log(
      `MixControl API: http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 3001}`,
    ),
);
async function shutdown() {
  clearInterval(sessionCleanup);
  await stopReportScheduler();
  await stopEvents();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
