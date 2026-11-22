// Fetches recent activity for a GitHub repository via the public REST API.
// Unauthenticated calls are limited to 60/hour (4 calls per repo per update);
// set the GITHUB_TOKEN environment variable to raise that to 5,000/hour.
import { toIso } from "./db.js";
import { summarizeReleaseNotes } from "./releaseNotes.js";

const API = "https://api.github.com";
const LOOKBACK_DAYS = 14;

async function gh(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "NewsWatcher",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(API + path, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) throw new Error("GitHub repo not found");
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const when = reset ? ` (resets ${new Date(reset * 1000).toLocaleTimeString()})` : "";
    throw new Error(`GitHub rate limit reached${when}; set GITHUB_TOKEN to raise it`);
  }
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res.json();
}

const firstLine = (s) => String(s ?? "").split("\n")[0].trim();

/** Returns article-shaped items: { kind, title, link, source, published_at }. */
export async function fetchRepoActivity(repo) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const recent = (d) => d && new Date(d) >= since;
  const [releases, pulls, issues, commits] = await Promise.all([
    gh(`/repos/${repo}/releases?per_page=20`),
    gh(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`),
    gh(`/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100&since=${toIso(since)}`),
    gh(`/repos/${repo}/commits?per_page=100&since=${toIso(since)}`),
  ]);

  const items = [];
  for (const r of releases) {
    if (r.draft || !recent(r.published_at)) continue;
    const summary = summarizeReleaseNotes(r.body);
    items.push({ kind: "release", title: `Released ${r.name || r.tag_name}`, link: r.html_url,
                 source: `${repo} ${r.tag_name}`, published_at: toIso(new Date(r.published_at)),
                 summary: summary ? JSON.stringify(summary) : null });
  }
  for (const p of pulls) {
    if (!recent(p.merged_at)) continue;
    items.push({ kind: "pr", title: p.title, link: p.html_url,
                 source: `PR #${p.number} by ${p.user?.login ?? "?"}`, published_at: toIso(new Date(p.merged_at)) });
  }
  for (const i of issues) {
    if (i.pull_request || !recent(i.created_at)) continue;
    items.push({ kind: "issue", title: i.title, link: i.html_url,
                 source: `Issue #${i.number} by ${i.user?.login ?? "?"}`, published_at: toIso(new Date(i.created_at)) });
  }
  for (const c of commits) {
    const msg = firstLine(c.commit?.message);
    // Skip merge commits and squash-merges of PRs (the PR itself is already listed).
    if (!msg || /^Merge (pull request|branch)/.test(msg) || /\(#\d+\)$/.test(msg)) continue;
    const date = c.commit?.committer?.date ?? c.commit?.author?.date;
    items.push({ kind: "commit", title: msg, link: c.html_url,
                 source: `Commit ${c.sha.slice(0, 7)} by ${c.author?.login ?? c.commit?.author?.name ?? "?"}`,
                 published_at: toIso(new Date(date)) });
  }
  return items;
}
