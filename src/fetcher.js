// Fetches news for each topic from Google News RSS and stores it.
import { XMLParser } from "fast-xml-parser";
import { getDb, nowIso, toIso } from "./db.js";
import { fetchRepoActivity } from "./github.js";

const RSS_URL = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=";
const RETENTION_DAYS = 60;
const USER_AGENT = "Mozilla/5.0 (compatible; NewsWatcher/1.0)";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === "item",
});

export function parseItems(xml) {
  const items = parser.parse(xml)?.rss?.channel?.item ?? [];
  const out = [];
  for (const item of items) {
    let title = String(item.title ?? "").trim();
    const link = String(item.link ?? "").trim();
    const source = String(item.source ?? "").trim();
    if (!title || !/^https?:\/\//.test(link)) continue;
    let published = new Date(item.pubDate);
    if (isNaN(published)) published = new Date();
    // Google News titles look like "Headline - Source"; strip the source suffix.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    out.push({ title, link, source, published_at: toIso(published) });
  }
  return out;
}

async function fetchNews(query) {
  const url = RSS_URL + encodeURIComponent(`${query} when:7d`);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Google News HTTP ${res.status}`);
  return parseItems(await res.text()).map((a) => ({ ...a, kind: "news" }));
}

/** Fetches news (and GitHub activity if the topic has a repo). Returns { added, errors }. */
async function fetchTopic(db, topic) {
  const sources = [["news", fetchNews(topic.query)]];
  if (topic.github_repo) sources.push([`GitHub ${topic.github_repo}`, fetchRepoActivity(topic.github_repo)]);

  const items = [];
  const errors = [];
  for (const [label, p] of sources) {
    try { items.push(...(await p)); } catch (e) { errors.push(`${label}: ${e.message}`); }
  }
  if (errors.length === sources.length) throw new Error(errors.join("; "));

  const fetched = nowIso();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO articles (topic_id, kind, title, link, source, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // Release notes can be edited after publishing, so refresh summaries on existing rows too.
  const setSummary = db.prepare(
    "UPDATE articles SET summary = ? WHERE topic_id = ? AND link = ? AND summary IS NOT ?"
  );
  let added = 0;
  db.exec("BEGIN");
  try {
    for (const a of items) {
      added += Number(ins.run(topic.id, a.kind, a.title, a.link, a.source, a.published_at, fetched).changes);
      if (a.summary !== undefined) setSummary.run(a.summary, topic.id, a.link, a.summary);
    }
    db.prepare("UPDATE topics SET last_fetched_at = ? WHERE id = ?").run(fetched, topic.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { added, errors };
}

/** Fetch news for all topics (or one). Returns a summary object. */
export async function updateAll(topicId = null, log = console) {
  const db = getDb();
  const runId = db.prepare("INSERT INTO runs (started_at, status) VALUES (?, 'running')").run(nowIso()).lastInsertRowid;
  const topics = topicId
    ? db.prepare("SELECT * FROM topics WHERE id = ?").all(topicId)
    : db.prepare("SELECT * FROM topics").all();

  const summary = { added: 0, topics: 0, errors: [] };
  for (const t of topics) {
    try {
      const { added, errors } = await fetchTopic(db, t);
      summary.added += added;
      summary.topics += 1;
      for (const err of errors) summary.errors.push(`${t.name}: ${err}`);
      log.info(`Topic '${t.name}': ${added} new items` + (errors.length ? ` (warnings: ${errors.join("; ")})` : ""));
    } catch (e) {
      summary.errors.push(`${t.name}: ${e.message}`);
      log.error(`Failed to fetch topic '${t.name}':`, e);
    }
  }

  const cutoff = toIso(new Date(Date.now() - RETENTION_DAYS * 86_400_000));
  db.prepare("DELETE FROM articles WHERE published_at < ?").run(cutoff);

  summary.status = summary.errors.length === 0 ? "ok" : summary.topics ? "partial" : "failed";
  let msg = `${summary.added} new articles across ${summary.topics} topic(s)`;
  if (summary.errors.length) msg += "; errors: " + summary.errors.join(" | ");
  db.prepare("UPDATE runs SET finished_at = ?, status = ?, message = ? WHERE id = ?")
    .run(nowIso(), summary.status, msg, runId);
  return summary;
}
