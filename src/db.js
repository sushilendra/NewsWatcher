// SQLite storage for NewsWatcher, using Node's built-in node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const DB_PATH = path.join(DATA_DIR, "newswatcher.db");

const DEFAULT_TOPICS = [
  ["Artificial Intelligence", "artificial intelligence"],
  ["Stock Market", "stock market"],
  ["Climate & Energy", "climate change OR renewable energy"],
  ["Space Exploration", "space exploration OR NASA OR SpaceX"],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS topics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    query           TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    last_fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id     INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    link         TEXT NOT NULL,
    source       TEXT,
    published_at TEXT NOT NULL,
    fetched_at   TEXT NOT NULL,
    UNIQUE(topic_id, link)
);
CREATE INDEX IF NOT EXISTS idx_articles_topic_pub ON articles(topic_id, published_at DESC);
CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,
    message     TEXT
);
`;

/** UTC timestamp as "YYYY-MM-DDTHH:MM:SS+00:00" (sortable as text). */
export function toIso(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
export const nowIso = () => toIso();

/** Local hour of the daily update. */
export const NIGHTLY_HOUR = 2;

/** The most recent scheduled update time (today's 02:00, or yesterday's if it's not 02:00 yet). */
export function lastScheduledRun() {
  const t = new Date();
  t.setHours(NIGHTLY_HOUR, 0, 0, 0);
  if (t > new Date()) t.setDate(t.getDate() - 1);
  return t;
}

/** Adds columns introduced after the first version, if missing. */
function migrate(db) {
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols("topics").includes("github_repo")) db.exec("ALTER TABLE topics ADD COLUMN github_repo TEXT");
  // kind: news | release | pr | issue | commit
  if (!cols("articles").includes("kind")) db.exec("ALTER TABLE articles ADD COLUMN kind TEXT NOT NULL DEFAULT 'news'");
  // summary: JSON from releaseNotes.summarizeReleaseNotes (releases only)
  if (!cols("articles").includes("summary")) db.exec("ALTER TABLE articles ADD COLUMN summary TEXT");
  // last_seen_at: when the user last viewed the topic; items fetched after it are unread.
  // Existing topics start as "all read" (NULL would mean everything is unread).
  if (!cols("topics").includes("last_seen_at")) {
    db.exec("ALTER TABLE topics ADD COLUMN last_seen_at TEXT");
    db.prepare("UPDATE topics SET last_seen_at = ?").run(nowIso());
  }
}

/** Accepts "owner/name" or a github.com URL; returns "owner/name" or null. Throws on junk. */
export function normalizeRepo(input) {
  const s = String(input ?? "").trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$|\/+$/g, "");
  if (!s) return null;
  const m = s.match(/^([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error("GitHub repo must look like owner/name");
  return `${m[1]}/${m[2]}`;
}

let db;

/** Returns the shared connection, creating the schema and default topics on first use. */
export function getDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000;");
  db.exec(SCHEMA);
  migrate(db);
  if (db.prepare("SELECT COUNT(*) AS n FROM topics").get().n === 0) {
    const ins = db.prepare("INSERT INTO topics (name, query, created_at) VALUES (?, ?, ?)");
    for (const [name, query] of DEFAULT_TOPICS) ins.run(name, query, nowIso());
  }
  return db;
}
