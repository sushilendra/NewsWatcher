// Runs one news update (used by the nightly Windows scheduled task).
//   node src/update.js              update every topic now   (npm run update)
//   node src/update.js --if-missed  only if today's 02:00 update hasn't happened yet
//                                   (the scheduled task uses this, so a running server
//                                    and the task don't both fetch on the same night)
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, getDb, lastScheduledRun, toIso } from "./db.js";
import { updateAll } from "./fetcher.js";

mkdirSync(DATA_DIR, { recursive: true });
const LOG_FILE = path.join(DATA_DIR, "update.log");

function write(level, args) {
  const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ")}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}
const log = { info: (...a) => write("INFO", a), error: (...a) => write("ERROR", a) };

if (process.argv.includes("--if-missed")) {
  const stale = getDb().prepare(
    "SELECT COUNT(*) AS n FROM topics WHERE last_fetched_at IS NULL OR last_fetched_at < ?"
  ).get(toIso(lastScheduledRun())).n;
  if (stale === 0) {
    log.info(`All topics already updated since ${lastScheduledRun().toLocaleString()}; nothing to do`);
    process.exit(0);
  }
}

const summary = await updateAll(null, log);
log.info("Update finished:", JSON.stringify(summary));
// A non-zero exit makes Task Scheduler retry (3 times, 10 minutes apart). Retry when every
// topic failed (e.g. no network yet); a partial result (one source failing) is kept as is.
process.exitCode = summary.status === "failed" ? 1 : 0;
