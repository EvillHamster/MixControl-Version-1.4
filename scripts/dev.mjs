import "dotenv/config";
import { concurrently } from "concurrently";

const { result } = concurrently(
  [
    { name: "api", command: "tsx watch server/index.ts" },
    { name: "web", command: "node scripts/dev-web.mjs" },
  ],
  { killOthersOn: ["failure", "success"], killTimeout: 5000 },
);
try {
  await result;
} catch {
  console.error(
    "MixControl не запустился. Проверьте настройки SQLSERVER_* в .env и сообщения выше.",
  );
  process.exitCode = 1;
}
