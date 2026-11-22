# NewsWatcher

A small local web app that watches news topics. The home page shows a card per topic;
clicking a card shows that topic's highlights grouped by day (last 14 days).
News is pulled from Google News RSS — no API key needed — and stored in SQLite (`data/newswatcher.db`)
via Node's built-in `node:sqlite`.

Requires Node.js 22.13+ (developed on 26). Dependencies: `express`, `fast-xml-parser`.

## Run

```powershell
npm install
npm start
```

Then open http://localhost:8000. Use `node src/server.js --port 3000` to pick another port.
The server listens on both IPv4 and IPv6 loopback (local-only), and tells browsers not to cache
the frontend, so a normal reload always picks up changes.

- **+ Watch a topic** adds a card. The optional query supports Google News syntax: `OR`, `"exact phrase"`, `-exclude`.
  Optionally link a **GitHub repo** (`owner/name` or its URL) to track the project's releases and development.
- **Edit** (on a topic page) changes a topic's name, news query or GitHub repo.
- **×** on a card stops watching that topic.

### What a topic page shows

Each day lists only **headlines**: news articles and stable GitHub releases (up to 6 a day).
Each release has a 2–3 line summary pulled from its release notes: an overview sentence, then
the number of **fixes** and **improvements** with the top three of each.

Everything else from GitHub (merged PRs, new issues, direct commits, nightly / release-candidate
builds) is folded into one collapsed **Development** line per day; click it for the details.

### Read / unread

Anything fetched since you last opened a topic is **unread**. Cards show "N unread" (and a blue
edge); opening the topic shows just the unread items, from however far back (up to 60 days),
with a **Show all** toggle. Leaving the page (or closing the tab) marks what you saw as read;
**Mark all read** does it immediately. Items that arrive while you're reading stay unread.

GitHub's API allows 60 unauthenticated requests per hour, and each linked repo uses 4 per update.
Set a `GITHUB_TOKEN` environment variable to raise the limit to 5,000.

### Your data

Topics, articles and release summaries live in `data/newswatcher.db` and survive restarts.
Back up that one file to keep everything; delete it to start over with the default topics.

## Nightly updates

Two mechanisms, use either or both:

1. **While the app is running** it updates once a day, at 02:00. On startup it catches up only if
   that run was missed (e.g. the PC was off). Adding a topic, or changing a topic's query / repo,
   fetches that topic immediately; renaming doesn't. The page doesn't poll in the background.
   To force an update by hand: `npm run update`.
2. **Windows Task Scheduler** (updates even when the app isn't running):

   ```powershell
   .\scripts\register_nightly_task.ps1
   ```

   The task runs at 02:30 **and 2 minutes after you log in**, always with `--if-missed`: if the
   day's update already happened (by the app at 02:00, or an earlier task run), it does nothing,
   so there's still at most one update a day. Laptop-friendly: it runs on battery, catches up as
   soon as possible if the PC was off or asleep, never wakes the PC, and retries 3 times
   (10 minutes apart) if a run fails, e.g. because there's no network yet. Logs go to `data/update.log`.

   Check it with `Get-ScheduledTaskInfo -TaskName NewsWatcherNightly` (LastTaskResult 0 = success).
   Remove it with `Unregister-ScheduledTask -TaskName NewsWatcherNightly -Confirm:$false`.

## Layout

| Path | Purpose |
|---|---|
| `src/server.js` | Express server: JSON API, static files, in-app nightly scheduler |
| `src/update.js` | one-shot update (used by the scheduled task) |
| `src/db.js` | SQLite schema, default topics |
| `src/fetcher.js` | Google News RSS fetch, dedupe, 60-day retention |
| `src/github.js` | GitHub releases, merged PRs, new issues, commits |
| `src/releaseNotes.js` | turns release notes into the 2–3 line summary |
| `static/` | frontend (HTML/CSS/vanilla JS) |
