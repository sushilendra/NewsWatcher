// Turns a GitHub release body (markdown) into a 2–3 line summary:
//   { overview, fixes: { count, top: [...] }, improvements: { count, top: [...] } }
// Understands "### Fixes / ### Improvements / ### Features"-style sections and
// GitHub's auto-generated "What's Changed" lists with fix:/feat: prefixes.

const TOP_N = 3;
const MAX_LABEL = 70;

const FIX_HEADING = /\b(fix|fixes|fixed|bug|bugs|bugfix(es)?)\b/i;
const IMPROVE_HEADING = /(improv|enhanc|feature|added|new in this|^new$|^changes?$)/i;
const OVERVIEW_HEADING = /(what'?s new|highlights|summary|overview)/i;
const CHANGELOG_HEADING = /what'?s changed|changelog/i;

/** Strip markdown so text reads cleanly. */
function plain(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")          // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")       // links -> text
    .replace(/\s*\(#\d+(,\s*#\d+)*\)/g, "")         // (#123) refs
    .replace(/\s+by @[\w-]+ in https?:\/\/\S+/g, "") // "by @x in <url>"
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(s, max = MAX_LABEL) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 15)).replace(/[,;:\s]+$/, "") + "…";
}

/** Short label for a bullet: its bold lead-in if it has one, else its first clause. */
const firstClause = (text) => text.split(/(?<=[a-z0-9)])[.;:](\s|$)| — | – |, so /)[0].trim();

function bulletLabel(raw) {
  const lead = raw.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
  if (lead) {
    const head = plain(lead[1]).replace(/[:.]$/, "");
    const rest = firstClause(plain(lead[2]).replace(/^[:.\s]+/, ""));
    // A one- or two-word lead-in ("Export", "Detail views") says too little on its own.
    if (head.split(" ").length <= 2 && rest) return shorten(`${head}: ${rest}`, MAX_LABEL + 15);
    return shorten(head);
  }
  const text = firstClause(plain(raw).replace(/^(fix|feat|perf|refactor)(\([^)]*\))?!?:\s*/i, ""));
  return shorten(text.charAt(0).toUpperCase() + text.slice(1));
}

/** Split markdown into sections: { level, heading, lines }. */
function sections(md) {
  const out = [{ level: 0, heading: "", lines: [] }];
  for (const line of md.replace(/\r/g, "").split("\n")) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) out.push({ level: h[1].length, heading: plain(h[2]), lines: [] });
    else out.at(-1).lines.push(line);
  }
  return out;
}

/** Top-level bullets, with wrapped continuation lines joined on. */
function bullets(lines) {
  const out = [];
  for (const line of lines) {
    const b = line.match(/^[-*+]\s+(.*)$/);
    if (b) out.push(b[1]);
    else if (out.length && /^\s{2,}\S/.test(line) && !/^\s+[-*+]\s/.test(line)) out[out.length - 1] += " " + line.trim();
  }
  return out;
}

function firstParagraph(lines) {
  const para = [];
  for (const l of lines) {
    if (!l.trim()) { if (para.length) break; continue; }
    if (/^[-*+]\s|^```|^\|/.test(l)) break;
    para.push(l.trim());
  }
  const text = plain(para.join(" "));
  // Up to two sentences, capped. A sentence ends at .!? followed by a space,
  // so version numbers like 0.46.2 don't split.
  const sentences = (text.match(/.+?[.!?](?=\s|$)/g) ?? [text]).map((s) => s.trim());
  // One sentence, or two when the first is just "X is a patch release."-style filler.
  const take = sentences[0]?.length < 40 ? 2 : 1;
  return shorten(sentences.slice(0, take).join(" "), 170);
}

// For notes grouped by area (Speed, Modeling, …) rather than Fixes/Improvements.
const FIX_WORDING = /\b(fix|fixes|fixed|fixing|no longer|crash(es|ed)?|regression|slowdown|instead of failing|works again|again\b)/i;

/** Bold lead-in bullets are the headline items: list them first. */
const headlineFirst = (list) => [...list.filter((b) => b.startsWith("**")), ...list.filter((b) => !b.startsWith("**"))];

export function summarizeReleaseNotes(md) {
  if (!md || !md.trim()) return null;
  const fixes = [];
  const improvements = [];
  let overview = "";

  let overviewLevel = 0; // >0 while inside a "What's new"/"Highlights" section
  const byArea = []; // bullets from area subsections (classified by wording below)
  const autoFixes = []; // from GitHub's auto-generated "What's Changed" list,
  const autoImprovements = []; // used only when there are no hand-written notes

  for (const s of sections(md)) {
    if (!s.heading) continue;
    if (overviewLevel && s.level <= overviewLevel) overviewLevel = 0;
    const isOverview = OVERVIEW_HEADING.test(s.heading) && !CHANGELOG_HEADING.test(s.heading);
    if (isOverview && !overviewLevel) {
      overviewLevel = s.level;
      if (!overview) overview = firstParagraph(s.lines);
    }
    const items = bullets(s.lines);
    if (!items.length) continue;
    if (CHANGELOG_HEADING.test(s.heading)) {
      for (const b of items) {
        const t = plain(b);
        if (/^fix(\(|:|!|\s)/i.test(t)) autoFixes.push(b);
        else if (/^(feat|perf)(\(|:|!|\s)/i.test(t)) autoImprovements.push(b);
      }
    } else if (FIX_HEADING.test(s.heading)) fixes.push(...items);
    else if (IMPROVE_HEADING.test(s.heading) || (/\bnew\b/i.test(s.heading) && !isOverview)) improvements.push(...items);
    else if (overviewLevel) byArea.push(...items);
  }
  // Judge area bullets by their opening clause only; long bullets often mention
  // "no longer" in passing while describing a new feature.
  for (const b of byArea) (FIX_WORDING.test(firstClause(plain(b))) ? fixes : improvements).push(b);
  if (!fixes.length && !improvements.length) {
    fixes.push(...autoFixes);
    improvements.push(...autoImprovements);
  }

  const group = (list) => ({
    count: list.length,
    top: headlineFirst(list).slice(0, TOP_N).map(bulletLabel).filter(Boolean),
  });
  if (!overview && !fixes.length && !improvements.length) return null;
  return { overview, fixes: group(fixes), improvements: group(improvements) };
}
