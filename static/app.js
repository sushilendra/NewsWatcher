// NewsWatcher frontend — hash routing: "#/" = cards, "#/topic/<id>" = daily highlights.
const view = document.getElementById("view");
const statusEl = document.getElementById("status");
const addDialog = document.getElementById("addDialog");
const addForm = document.getElementById("addForm");

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function ago(iso) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function dayLabel(isoDate) {
  const d = new Date(isoDate + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  const long = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return diff === 0 ? `Today — ${long}` : diff === 1 ? `Yesterday — ${long}` : long;
}

function setStatus(lastRun, updating) {
  if (updating) statusEl.textContent = "Updating news…";
  else if (lastRun) statusEl.textContent = `Last update ${ago(lastRun.finished_at || lastRun.started_at)} (${lastRun.status})`;
  else statusEl.textContent = "No updates yet";
  if (lastRun && lastRun.message) statusEl.title = lastRun.message;
}

// ---------------------------------------------------------------- views

async function showCards() {
  const { topics, lastRun, updating } = await api("/api/topics");
  setStatus(lastRun, updating);
  const cards = topics.map(t => {
    const unreadMeta = t.unread
      ? el("span", { class: "badge" }, `${t.unread} unread`)
      : t.unread_activity
        ? el("span", { class: "dev-new" }, "new dev activity")
        : el("span", {}, "all read");
    return el("div", { class: "card" + (t.unread ? " unread" : ""), onclick: () => (location.hash = `#/topic/${t.id}`) },
      el("button", { class: "del", title: "Stop watching", onclick: e => removeTopic(e, t) }, "×"),
      el("h3", {}, t.name),
      el("div", { class: "latest" }, t.latest_title || (updating ? "Fetching news…" : "No news yet")),
      el("div", { class: "meta" }, unreadMeta, el("span", {}, `updated ${ago(t.last_fetched_at)}`)));
  });
  cards.push(el("div", { class: "card add", onclick: () => openTopicDialog() }, "+ Watch a topic"));
  view.replaceChildren(el("h1", {}, "What you're watching"), el("div", { class: "grid" }, cards));
}

// ---- read / unread
// Items fetched after the topic's last_seen_at are unread. They're marked read when you
// leave the topic page (or close the tab), up to the newest item the page showed, so
// anything that arrives while you're reading stays unread.
let pendingSeen = null; // { id, upTo }
function flushSeen() {
  if (!pendingSeen) return Promise.resolve();
  const { id, upTo } = pendingSeen;
  pendingSeen = null;
  return fetch(`/api/topics/${id}/seen`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upTo }), keepalive: true,
  }).catch(() => {});
}
window.addEventListener("pagehide", flushSeen);

let unreadOnly = null; // per visit: null = decide from data
let unreadOnlyTopic = null;

async function showTopic(id) {
  const data = await api(`/api/topics/${id}/highlights?days=14`);
  const { topic, days, unreadCount, unreadActivity, latestFetchedAt } = data;
  document.title = `${topic.name} — NewsWatcher`;
  const anyUnread = unreadCount + unreadActivity > 0;
  if (anyUnread && latestFetchedAt) pendingSeen = { id: topic.id, upTo: latestFetchedAt };
  if (unreadOnlyTopic !== topic.id) { unreadOnlyTopic = topic.id; unreadOnly = anyUnread; }
  const filtering = unreadOnly && anyUnread;

  const head = el("div", { class: "detail-head" },
    el("a", { href: "#/" }, "← All topics"),
    el("h1", {}, topic.name),
    el("button", { class: "btn ghost small", onclick: () => openTopicDialog(topic) }, "Edit"),
    el("span", { class: "muted" },
      `news query: ${topic.query}` + (topic.github_repo ? ` · GitHub: ${topic.github_repo}` : "") +
      ` · updated ${ago(topic.last_fetched_at)}`));

  const bar = anyUnread
    ? el("div", { class: "unread-bar" },
        el("span", { class: "dot" }),
        el("span", {}, [
          unreadCount ? `${unreadCount} unread headline${unreadCount === 1 ? "" : "s"}` : null,
          unreadActivity ? `${unreadActivity} new development update${unreadActivity === 1 ? "" : "s"}` : null,
        ].filter(Boolean).join(" · ") + (topic.last_seen_at ? ` since you last looked (${ago(topic.last_seen_at)})` : "")),
        el("button", { class: "btn ghost small", onclick: () => { unreadOnly = !unreadOnly; route(); } },
          filtering ? "Show all" : "Unread only"),
        el("button", { class: "btn small", onclick: async () => { await flushSeen(); unreadOnlyTopic = null; route(); } },
          "Mark all read"))
    : null;

  const itemLi = (a, withNotes = false) => el("li", { class: a.unread ? "is-unread" : "" },
    el("span", { class: `kind kind-${a.kind}` }, KIND_LABEL[a.kind] ?? a.kind),
    el("a", { href: a.link, target: "_blank", rel: "noopener noreferrer" }, a.title),
    el("span", { class: "src" }, [a.kind === "release" ? null : a.source, a.time].filter(Boolean).join(" · ")),
    withNotes ? releaseNotes(a.summary) : null);

  const shownDays = days
    .map(d => filtering
      ? { ...d, highlights: d.highlights.filter(a => a.unread), details: d.details.filter(a => a.unread),
          activity: d.activityUnread, moreHighlights: 0 }
      : d)
    .filter(d => !filtering || d.highlights.length || summarizeActivity(d.activity));

  const body = shownDays.length
    ? shownDays.map(d => {
        const activity = summarizeActivity(d.activity);
        const newDev = !filtering && summarizeActivity(d.activityUnread) ? " · new" : "";
        return el("section", { class: "day" + (d.unread || summarizeActivity(d.activityUnread) ? " has-unread" : "") },
          el("h2", {}, dayLabel(d.date), d.unread ? el("span", { class: "day-unread" }, `${d.unread} unread`) : null),
          d.highlights.length
            ? el("ol", {}, d.highlights.map(a => itemLi(a, true)))
            : el("p", { class: "quiet" }, filtering ? "No unread headlines." : "No major news or releases."),
          d.moreHighlights ? el("p", { class: "quiet" }, `+ ${d.moreHighlights} more stories`) : null,
          activity
            ? el("details", { class: "activity" },
                el("summary", {}, `Development: ${activity}${newDev}`),
                el("ol", {}, d.details.map(a => itemLi(a))))
            : null);
      })
    : [el("div", { class: "empty" }, "No highlights in the last 14 days — try Edit to broaden the query or add a GitHub repo.")];
  view.replaceChildren(head, ...(bar ? [bar] : []), ...body);
}

const KIND_LABEL = { news: "News", release: "Release", pr: "PR", issue: "Issue", commit: "Commit" };
const ACTIVITY_LABEL = { pr: ["PR merged", "PRs merged"], issue: ["issue opened", "issues opened"],
                         commit: ["commit", "commits"], prerelease: ["test build", "test builds"] };

function summarizeActivity(activity = {}) {
  return Object.entries(ACTIVITY_LABEL).filter(([k]) => activity[k])
    .map(([k, [one, many]]) => `${activity[k]} ${activity[k] === 1 ? one : many}`).join(" · ");
}

// 2–3 line release summary: overview, then top fixes and improvements.
function releaseNotes(s) {
  if (!s) return null;
  const line = (label, g) => g && g.count
    ? el("div", {}, el("b", {}, `${label} (${g.count}): `), g.top.join("; ") + (g.count > g.top.length ? "; …" : ""))
    : null;
  const lines = [s.overview ? el("div", { class: "overview" }, s.overview) : null,
                 line("Fixes", s.fixes), line("Improvements", s.improvements)].filter(Boolean);
  return lines.length ? el("div", { class: "notes" }, lines) : null;
}

// Add / edit topic dialog. editing = topic object when editing, null when adding.
let editing = null;
function openTopicDialog(topic = null) {
  editing = topic;
  addForm.reset();
  document.getElementById("topicDialogTitle").textContent = topic ? `Edit "${topic.name}"` : "Watch a new topic";
  document.getElementById("topicDialogSubmit").textContent = topic ? "Save" : "Add";
  if (topic) {
    addForm.elements.name.value = topic.name;
    addForm.elements.query.value = topic.query;
    addForm.elements.githubRepo.value = topic.github_repo ?? "";
  }
  addDialog.showModal();
}

// In-page confirmation (native confirm() is blocked in some embedded browsers).
const confirmDialog = document.getElementById("confirmDialog");
function askConfirm(text) {
  document.getElementById("confirmText").textContent = text;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  return new Promise(resolve =>
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "ok"), { once: true }));
}

async function removeTopic(e, t) {
  e.stopPropagation();
  if (!(await askConfirm(`"${t.name}" and its saved articles will be removed.`))) return;
  try {
    await api(`/api/topics/${t.id}`, { method: "DELETE" });
  } catch (err) { alert(`Could not remove topic: ${err.message}`); }
  route();
}

// ---------------------------------------------------------------- wiring

async function route() {
  document.title = "NewsWatcher";
  const m = location.hash.match(/^#\/topic\/(\d+)/);
  // Leaving a topic page marks what it showed as read (before the cards load their counts).
  if (pendingSeen && (!m || Number(m[1]) !== pendingSeen.id)) await flushSeen();
  // Each visit to a topic starts fresh: unread-only if there's anything unread.
  if (!m || Number(m[1]) !== unreadOnlyTopic) unreadOnlyTopic = null;
  try {
    if (m) await showTopic(m[1]); else await showCards();
  } catch (err) {
    view.replaceChildren(el("div", { class: "empty" }, `Error: ${err.message}`));
  }
}

// The page only checks status while an update is running (after adding / editing a topic,
// or a catch-up at server start). No constant background polling.
let watching = false;
async function watchUpdate() {
  if (watching) return;
  watching = true;
  try {
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      let s;
      try { s = await api("/api/status"); } catch { continue; } // server may be restarting
      setStatus(s.lastRun, s.updating);
      if (!s.updating) break;
    }
  } finally { watching = false; }
  route(); // show the freshly fetched items
}

async function checkStatusOnce() {
  try {
    const { lastRun, updating } = await api("/api/status");
    setStatus(lastRun, updating);
    if (updating) watchUpdate();
  } catch { /* ignore */ }
}

addForm.addEventListener("submit", async e => {
  e.preventDefault(); // keep the dialog open until the save succeeds
  const errEl = document.getElementById("topicDialogError");
  errEl.textContent = "";
  const fd = new FormData(addForm);
  const body = JSON.stringify({ name: fd.get("name"), query: fd.get("query"), githubRepo: fd.get("githubRepo") });
  try {
    const fetching = editing
      ? (await api(`/api/topics/${editing.id}`, { method: "PATCH", body })).fetching
      : (await api("/api/topics", { method: "POST", body }), true);
    addDialog.close();
    route();
    if (fetching) watchUpdate();
  } catch (err) { errEl.textContent = err.message; }
});

window.addEventListener("hashchange", route);
route();
checkStatusOnce();
