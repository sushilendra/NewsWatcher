// NewsWatcher web server: JSON API + static frontend + nightly scheduler.
//   node src/server.js [--port 8000] [--host <addr>]   (default: 127.0.0.1 and ::1)
import express from "express";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { getDb, lastScheduledRun, NIGHTLY_HOUR, normalizeRepo, nowIso, toIso } from "./db.js";
import { updateAll } from "./fetcher.js";

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "static");

const log = {
  info: (...a) => console.log(new Date().toISOString(), "INFO", ...a),
  error: (...a) => console.error(new Date().toISOString(), "ERROR", ...a),
};

// ---------------------------------------------------------------- updates

let updating = false;
const queued = new Set(); // topic ids added while an update was running

/** Start an update unless one is already running. Returns false if skipped. */
function startUpdate(topicId = null) {
  if (updating) return false;
  updating = true;
  updateAll(topicId, log)
    .then((s) => log.info("Update finished:", JSON.stringify(s)))
    .catch((e) => log.error("Update failed:", e))
    .finally(() => {
      updating = false;
      const [next] = queued;
      if (next !== undefined) {
        queued.delete(next);
        startUpdate(next);
      }
    });
  return true;
}

// ---------------------------------------------------------------- queries

// SQL twin of isHighlight(): news, or a release whose tag isn't a pre-release build.
const HIGHLIGHT_SQL = `(a.kind = 'news' OR (a.kind = 'release' AND NOT (${
  ["nightly", "rc", "alpha", "beta", "dev", "pre", "preview", "canary"].map((s) => `a.source LIKE '%-${s}%'`).join(" OR ")
})))`;

// An item is unread if it was fetched after the user last viewed its topic.
const UNREAD_SQL = "(t.last_seen_at IS NULL OR a.fetched_at > t.last_seen_at)";

function listTopics() {
  return getDb().prepare(`
    SELECT t.*,
           (SELECT COUNT(*) FROM articles a WHERE a.topic_id = t.id AND ${HIGHLIGHT_SQL}) AS article_count,
           (SELECT COUNT(*) FROM articles a WHERE a.topic_id = t.id AND ${HIGHLIGHT_SQL}
                AND ${UNREAD_SQL}) AS unread,
           (SELECT COUNT(*) FROM articles a WHERE a.topic_id = t.id AND NOT ${HIGHLIGHT_SQL}
                AND ${UNREAD_SQL}) AS unread_activity,
           (SELECT title FROM articles a WHERE a.topic_id = t.id AND ${HIGHLIGHT_SQL}
                ORDER BY published_at DESC LIMIT 1) AS latest_title
    FROM topics t ORDER BY t.name COLLATE NOCASE`).all();
}

const pad = (n) => String(n).padStart(2, "0");
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Each day is split into high-level highlights (stable releases + news) and
// collapsed development activity (PRs, issues, commits, pre-release builds).
const PRERELEASE = /-(nightly|rc|alpha|beta|dev|pre|preview|canary)\b/i;
const isHighlight = (a) => a.kind === "news" || (a.kind === "release" && !PRERELEASE.test(a.source ?? ""));
const KIND_RANK = { release: 0, news: 1, pr: 2, issue: 3, commit: 4 };
const MAX_HIGHLIGHTS = 6;
const MAX_DETAILS = 30;

function topicHighlights(topicId, days = 14) {
  const db = getDb();
  const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId);
  if (!topic) return null;
  const since = toIso(new Date(Date.now() - days * 86_400_000));
  const seen = topic.last_seen_at ?? "";
  // The last `days` days, plus anything still unread however old (up to the 60-day retention),
  // so returning after a long break still shows every unread update.
  const rows = db.prepare(
    `SELECT kind, title, link, source, published_at, fetched_at, summary FROM articles
     WHERE topic_id = ? AND (published_at >= ? OR fetched_at > ?) ORDER BY published_at DESC`
  ).all(topicId, since, seen);

  const byDay = new Map();
  for (const r of rows) {
    const d = new Date(r.published_at);
    const day = localDate(d);
    if (!byDay.has(day)) {
      byDay.set(day, { date: day, highlights: [], details: [], activity: {}, activityUnread: {}, dedupe: new Set() });
    }
    const b = byDay.get(day);
    const unread = r.fetched_at > seen;
    const item = { ...r, unread, summary: r.summary ? JSON.parse(r.summary) : null, time: localTime(d) };
    if (isHighlight(r)) {
      const key = r.title.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 60);
      if (b.dedupe.has(key)) continue;
      b.dedupe.add(key);
      b.highlights.push(item);
    } else {
      const k = r.kind === "release" ? "prerelease" : r.kind;
      b.activity[k] = (b.activity[k] ?? 0) + 1;
      if (unread) b.activityUnread[k] = (b.activityUnread[k] ?? 0) + 1;
      b.details.push(item);
    }
  }
  // Unread first (so the per-day caps never hide them), then by kind, then newest.
  const order = (x, y) => (y.unread - x.unread) || (KIND_RANK[x.kind] ?? 9) - (KIND_RANK[y.kind] ?? 9)
    || y.published_at.localeCompare(x.published_at);
  let unreadCount = 0;
  let unreadActivity = 0;
  const out = [...byDay.values()].map(({ dedupe, highlights, details, ...b }) => {
    const unreadHere = highlights.filter((h) => h.unread).length;
    unreadCount += unreadHere;
    unreadActivity += details.filter((x) => x.unread).length;
    return {
      ...b,
      unread: unreadHere,
      highlights: highlights.sort(order).slice(0, Math.max(MAX_HIGHLIGHTS, unreadHere)),
      moreHighlights: Math.max(0, highlights.length - Math.max(MAX_HIGHLIGHTS, unreadHere)),
      details: details.sort(order).slice(0, MAX_DETAILS),
    };
  });
  const latestFetchedAt = db.prepare("SELECT MAX(fetched_at) AS m FROM articles WHERE topic_id = ?").get(topicId).m;
  return { topic, days: out, unreadCount, unreadActivity, latestFetchedAt };
}

const lastRun = () => getDb().prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get() ?? null;

// ---------------------------------------------------------------- HTTP

const app = express();
app.use(express.json());
app.use("/api", (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

app.get("/api/topics", (req, res) => res.json({ topics: listTopics(), lastRun: lastRun(), updating }));

app.get("/api/status", (req, res) => res.json({ lastRun: lastRun(), updating }));

app.get("/api/topics/:id/highlights", (req, res) => {
  const days = Math.max(1, Math.min(60, parseInt(req.query.days, 10) || 14));
  const data = topicHighlights(Number(req.params.id), days);
  data ? res.json(data) : res.status(404).json({ error: "not found" });
});

app.post("/api/topics", (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const query = (String(req.body?.query ?? "").trim() || name).slice(0, 200);
  if (!name) return res.status(400).json({ error: "name is required" });
  let repo;
  try { repo = normalizeRepo(req.body?.githubRepo); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const id = Number(getDb().prepare("INSERT INTO topics (name, query, github_repo, created_at) VALUES (?, ?, ?, ?)")
      .run(name, query, repo, nowIso()).lastInsertRowid);
    if (!startUpdate(id)) queued.add(id);
    res.status(201).json({ id });
  } catch {
    res.status(409).json({ error: "a topic with that name already exists" });
  }
});

app.patch("/api/topics/:id", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(id);
  if (!topic) return res.status(404).json({ error: "not found" });
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 80) : topic.name;
  const query = req.body?.query !== undefined ? (String(req.body.query).trim() || name).slice(0, 200) : topic.query;
  if (!name) return res.status(400).json({ error: "name is required" });
  let repo = topic.github_repo;
  if (req.body?.githubRepo !== undefined) {
    try { repo = normalizeRepo(req.body.githubRepo); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  try {
    db.prepare("UPDATE topics SET name = ?, query = ?, github_repo = ? WHERE id = ?").run(name, query, repo, id);
  } catch {
    return res.status(409).json({ error: "a topic with that name already exists" });
  }
  // Only fetch again if what we fetch changed (not for a rename).
  const sourcesChanged = query !== topic.query || repo !== topic.github_repo;
  if (sourcesChanged && !startUpdate(id)) queued.add(id);
  res.json({ ok: true, fetching: sourcesChanged });
});

// Mark a topic read up to `upTo` (the newest fetched_at the page displayed), so items
// fetched while the page was open stay unread. Never moves backwards.
app.post("/api/topics/:id/seen", (req, res) => {
  const upTo = String(req.body?.upTo ?? "");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/.test(upTo)) return res.status(400).json({ error: "bad upTo" });
  getDb().prepare(
    "UPDATE topics SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)"
  ).run(upTo, Number(req.params.id), upTo);
  res.json({ ok: true });
});

app.delete("/api/topics/:id", (req, res) => {
  getDb().prepare("DELETE FROM topics WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));
// Never cache the frontend: it's tiny and local, and stale JS after an update
// breaks the page (old code reading the new API shape).
app.use(express.static(STATIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set("Cache-Control", "no-store"),
}));

// ---------------------------------------------------------------- scheduler

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(NIGHTLY_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function scheduleNightly() {
  const wait = msUntilNextRun();
  log.info(`Next nightly update in ${(wait / 3600_000).toFixed(1)} hours`);
  setTimeout(() => {
    log.info("Running nightly update");
    startUpdate();
    scheduleNightly();
  }, wait);
}

/** Updates once a day: on startup, only catch up if the last scheduled run was missed. */
function catchUpIfMissed() {
  const since = toIso(lastScheduledRun());
  const stale = getDb().prepare(
    "SELECT COUNT(*) AS n FROM topics WHERE last_fetched_at IS NULL OR last_fetched_at < ?"
  ).get(since).n;
  if (stale > 0) {
    log.info("Missed the last nightly update; catching up now");
    startUpdate();
  } else {
    log.info(`Already updated since ${lastScheduledRun().toLocaleString()}; next update at the nightly run`);
  }
}

// ---------------------------------------------------------------- main

const { values: args } = parseArgs({
  options: { host: { type: "string" }, port: { type: "string", default: "8000" } },
});
const port = Number(args.port);

// By default listen on both IPv4 and IPv6 loopback: some browsers (e.g. Brave) resolve
// "localhost" to ::1 only and won't fall back to 127.0.0.1. Still local-only.
const hosts = args.host ? [args.host] : ["127.0.0.1", "::1"];

function listen(host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("listening", () => resolve(host));
    server.once("error", reject);
  });
}

getDb();
const results = await Promise.allSettled(hosts.map(listen));
const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
for (const r of results) if (r.status === "rejected") log.error(`Could not listen: ${r.reason.message}`);
if (ok.length === 0) process.exit(1);
log.info(`NewsWatcher running at http://localhost:${port}  (listening on ${ok.join(", ")})`);
catchUpIfMissed();
scheduleNightly();
