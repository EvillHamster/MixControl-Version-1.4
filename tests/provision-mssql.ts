import assert from "node:assert/strict";
import sql from "mssql";
import { sqlConfig } from "../server/db.js";

const targets = [
  process.env.SQLSERVER_TEST_DATABASE,
  process.env.SQLSERVER_TEST_RESTORE_DATABASE,
];
assert.ok(
  targets[0] !== targets[1] &&
    targets.every(
      (name) => name && /^MixControlTest_[A-Za-z0-9_]+$/.test(name),
    ),
);
const until = Date.now() + 90000;
for (;;) {
  const db = new sql.ConnectionPool(sqlConfig("master"));
  try {
    await db.connect();
  } catch (error) {
    await db.close().catch(() => {});
    if (Date.now() >= until) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    continue;
  }
  try {
    for (const name of targets)
      await db.request().query("CREATE DATABASE [" + name + "];");
  } finally {
    await db.close();
  }
  break;
}
