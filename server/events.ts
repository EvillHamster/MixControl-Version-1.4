import { pool } from "./db.js";
import type { RequestHandler, Response } from "express";
import { currentUser } from "./auth.js";
// Each process reads only five committed counters, regardless of connected tabs.
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let pending: Promise<void> | undefined;
let previous: Map<string, string> | undefined;
const clients = new Map<Response, string>();
function broadcast(topic: string) {
  for (const res of clients.keys())
    res.write(`event: change\ndata: ${JSON.stringify(topic)}\n\n`);
}
export async function startEvents() {
  stopped = false;
  const poll = async () => {
    try {
      const { rows } = await pool.query<{ topic: string; revision: string }>(
        "SET LOCK_TIMEOUT 2000; SELECT topic,CONVERT(varchar(20),revision) AS revision FROM dbo.change_revision;",
      );
      const next = new Map(
        rows.map(({ topic, revision }) => [topic, revision]),
      );
      if (!previous) broadcast("reconnected");
      else
        for (const [topic, revision] of next)
          if (previous.get(topic) !== revision) broadcast(topic);
      previous = next;
    } catch {
      previous = undefined;
    }
  };
  const tick = () => {
    if (stopped) return;
    pending = poll().finally(() => {
      pending = undefined;
      if (!stopped) {
        timer = setTimeout(tick, 1000);
        timer.unref();
      }
    });
  };
  tick();
  await pending;
}
export const changeStream: RequestHandler = (req, res) => {
  const userId = currentUser(res).id;
  if ([...clients.values()].filter((id) => id === userId).length >= 5) {
    res.status(429).json({ message: "Открыто слишком много вкладок" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");
  clients.set(res, userId);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25000);
  const expiry = setTimeout(() => res.end(), 5 * 60 * 1000);
  req.on("close", () => {
    clients.delete(res);
    clearInterval(heartbeat);
    clearTimeout(expiry);
  });
};
export async function stopEvents() {
  stopped = true;
  if (timer) clearTimeout(timer);
  for (const res of clients.keys()) res.end();
  clients.clear();
  await pending;
}
