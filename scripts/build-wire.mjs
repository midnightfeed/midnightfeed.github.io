// The Night Wire — nightly build.
// Reads config/taxonomy.json, fetches every source, filters to the beat,
// and writes site/data/wire.json. Run by .github/workflows/build-and-deploy.yml.
//
//   node scripts/build-wire.mjs           normal nightly build (skips if tonight is built)
//   FORCE=1 node scripts/build-wire.mjs   rebuild regardless
//   node scripts/build-wire.mjs --check   feed check: report every source, write nothing

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const ROOT = new URL("..", import.meta.url);
const path = (p) => new URL(p, ROOT);
const CHECK = process.argv.includes("--check");
const FORCE = process.env.FORCE === "1";
const UA = "TheMidnightFeedBot/1.0 (+https://midnightfeed.net)";
const NOW = new Date();

const cfg = JSON.parse(await readFile(process.env.WIRE_CONFIG ? new URL(process.env.WIRE_CONFIG, "file://" + process.cwd() + "/") : path("config/taxonomy.json"), "utf8"));
const OUT = process.env.WIRE_OUT ? new URL(process.env.WIRE_OUT, "file://" + process.cwd() + "/") : path("site/data/wire.json");

// ---------- dates ----------
function chicagoDate(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const TONIGHT = chicagoDate(NOW);

if (!CHECK && !FORCE && existsSync(OUT)) {
  try {
    const prev = JSON.parse(await readFile(OUT, "utf8"));
    if (prev.built_for === TONIGHT) {
      console.log(`Already built for ${TONIGHT}. Nothing to do.`);
      process.exit(0);
    }
  } catch { /* rebuild */ }
}

// ---------- fetching ----------
// Entities are decoded by hand (decodeEntities): some feeds exceed the parser's entity limit.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", trimValues: true, processEntities: false, htmlEntities: false });

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }, signal: ctl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const txt = (v) => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return txt(v[0]);
  return txt(v["#text"] ?? v["@href"] ?? "");
};
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&hellip;/g, "…").replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
    .replace(/&rsquo;/g, "’").replace(/&lsquo;/g, "‘").replace(/&rdquo;/g, "”").replace(/&ldquo;/g, "“")
    .replace(/&amp;/g, "&");
}
// decode, strip tags, decode again: feeds may escape their HTML once or twice
const clean = (s) => decodeEntities(decodeEntities(String(s || "")).replace(/<[^>]*>/g, " ")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function snippetOf(s) {
  let t = clean(s).replace(/\s*(The post .* appeared first on .*|Continue reading.*|Read more.*|\[…\]|\[\.\.\.\])$/i, "").trim();
  if (t.length <= 200) return t;
  t = t.slice(0, 200);
  return t.slice(0, t.lastIndexOf(" ")).replace(/[,;:.\s]+$/, "") + "…";
}

// ---------- images (the lead only; never stored, only linked) ----------
const IMG_URL = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
function firstImg(html) {
  const m = decodeEntities(String(html || "")).match(/<img\b[^>]*?\bsrc=["']([^"']+)["']/i);
  return m ? m[1] : "";
}
// an image the feed itself offers: media:content / media:thumbnail / enclosure, else the first <img> in the body
function imageOf(i) {
  for (const k of ["media:content", "media:thumbnail", "enclosure"]) {
    for (const m of arr(i[k])) {
      const u = m && m["@url"];
      if (!u) continue;
      const type = m["@type"] || "", medium = m["@medium"] || "";
      if (/^image\//i.test(type) || medium === "image" || (!type && !medium && IMG_URL.test(u))) return u;
    }
  }
  return firstImg(txt(i["content:encoded"]) || txt(i.content)) || firstImg(txt(i.description) || txt(i.summary));
}

function parseFeed(xml) {
  const doc = parser.parse(xml);
  if (doc.rss) {
    return arr(doc.rss.channel?.item).map((i) => ({
      title: clean(txt(i.title)), url: decodeEntities(txt(i.link) || txt(i.guid)), date: txt(i.pubDate) || txt(i["dc:date"]),
      snippet: txt(i.description) || txt(i["content:encoded"]), image: imageOf(i),
    }));
  }
  if (doc.feed) {
    return arr(doc.feed.entry).map((e) => {
      const links = arr(e.link);
      const alt = links.find((l) => !l["@rel"] || l["@rel"] === "alternate") || links[0];
      return { title: clean(txt(e.title)), url: decodeEntities(alt ? alt["@href"] || txt(alt) : ""), date: txt(e.published) || txt(e.updated), snippet: txt(e.summary) || txt(e.content), image: imageOf(e) };
    });
  }
  if (doc["rdf:RDF"]) {
    return arr(doc["rdf:RDF"].item).map((i) => ({ title: clean(txt(i.title)), url: decodeEntities(txt(i.link)), date: txt(i["dc:date"]), snippet: txt(i.description) }));
  }
  throw new Error("not an RSS or Atom feed");
}

function googleNewsUrl(site, query) {
  const q = encodeURIComponent(query ? `${query} when:${cfg.freshness_days}d` : `site:${site} when:${cfg.freshness_days}d`);
  return `${cfg.google_news.base}?q=${q}&${cfg.google_news.params}`;
}
// Google News items: strip the " - Publisher" suffix, keep the publisher name, drop Google's snippet
async function googleNews(site, query) {
  const xml = await get(googleNewsUrl(site, query));
  const doc = parser.parse(xml);
  return arr(doc.rss?.channel?.item).map((i) => {
    const title = clean(txt(i.title));
    const publisher = clean(txt(i.source));
    const cut = title.lastIndexOf(" - ");
    return {
      title: cut > 0 ? title.slice(0, cut) : title,
      url: decodeEntities(txt(i.link)), date: txt(i.pubDate), snippet: "",
      gn: true, publisher,
    };
  });
}

async function fetchSource(src) {
  const report = { name: src.name, via: "", fetched: 0, error: "" };
  let items = [];
  if (src.query) {
    try { items = await googleNews(null, src.query); report.via = "google-news query"; }
    catch (e) { report.error = `google-news: ${e.message}`; }
    report.fetched = items.length;
    return { report, items: items.map((i) => ({ ...i, src })) };
  }
  if (src.feed) {
    try { items = parseFeed(await get(src.feed)); report.via = "feed"; }
    catch (e) { report.error = `feed: ${e.message}`; }
  }
  // fall back to Google News when there is no feed, it failed, or it has gone quiet
  const freshCut = NOW.getTime() - cfg.freshness_days * 864e5;
  const anyFresh = items.some((i) => Date.parse(i.date) >= freshCut);
  if (!anyFresh && src.site && src.gn_fallback !== false) {
    if (items.length) report.error = (report.error ? report.error + "; " : "") + "feed has nothing fresh";
    try {
      const gn = (await googleNews(src.site)).map((i) => ({ ...i, publisher: src.name }));
      report.gn = gn.length;
      items = items.concat(gn);
      report.via = report.via === "feed" ? "feed + google-news" : "google-news";
    } catch (e) { report.error += (report.error ? "; " : "") + `google-news: ${e.message}`; }
  }
  report.fetched = items.length;
  return { report, items: items.map((i) => ({ ...i, src })) };
}

async function pool(list, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } }));
  return out;
}

// ---------- matching ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (s, flags = "i") => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(s)}(?=$|[^\\p{L}\\p{N}])`, flags + "u");
const anyRe = (list, flags) => list.map((s) => wordRe(s, flags));

const QUAL = anyRe(cfg.qualifiers);
const METAL_QUAL = anyRe(cfg.metal_qualifiers || []);
const EXCL = (cfg.exclude_patterns || []).map((p) => ({ p, re: new RegExp(p, "i") }));
// a figure, statue, bust or mask story isn't a video-game story just because it names Fortnite or Nintendo
const COLLECTIBLE = cfg.collectible_words ? new RegExp(`(^|[^\\p{L}\\p{N}])(${cfg.collectible_words.map(esc).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu") : null;
const COLLECTIBLE_EXEMPT = new Set(cfg.collectible_exempt_excludes || []);

function terms(entry) {
  const e = typeof entry === "string" ? { name: entry, aliases: [] } : entry;
  const names = e.exact_aliases_only ? e.aliases : [e.name, ...(e.aliases || [])];
  // "IT" and other all-caps short titles match case-sensitively
  return { ...e, res: names.map((n) => (n.length <= 3 && n === n.toUpperCase() ? wordRe(n, "") : wordRe(n))) };
}
const T1 = Object.values(cfg.tier1).flat().map(terms);
const T2 = cfg.tier2.map(terms);

function classify(src, text) {
  if (src.category === "metal" || src.beat || !(cfg.category_override_from || []).includes(src.category)) return src.category;
  for (const [cat, words] of Object.entries(cfg.category_keywords || {})) {
    if (words.some((w) => wordRe(w).test(text))) return cat;
  }
  return src.category;
}

const ERA = cfg.era ? new RegExp(cfg.era.pattern) : null;
const GENRE = cfg.era?.genre_words ? anyRe(cfg.era.genre_words) : [];
const JUNK = (cfg.junk_title_patterns || []).map((p) => new RegExp(p, "i"));
const BLOCKED_PUB = new Set((cfg.blocked_publishers || []).map((x) => x.toLowerCase()));

const HORROR = anyRe(cfg.horror_words || []);
const METAL_GENRE = anyRe(cfg.metal_genre_words || []);
const METAL_LABELS = (cfg.metal_labels || []).map(terms);
const kindOf = (src) => src.kind || (src.category === "metal" ? "metal" : "general");

// v8 rules, in plain terms:
//   horror outlet  -> passes unless excluded
//   metal outlet   -> needs a classic band, an on-beat metal label, or a covered metal genre
//   anyone else    -> needs to be about horror: a horror word, or a watchlist name in the headline
// Classic material (watchlist names, period years, presses and labels, collector words) is flagged and ranked higher.
function judge(item) {
  const text = `${item.title} ${clean(item.snippet)}`;
  const head = item.title;
  const category = classify(item.src, text);
  const collectible = category === "gear" && COLLECTIBLE && COLLECTIBLE.test(head);
  if (EXCL.some((x) => x.re.test(item.title) && !(collectible && COLLECTIBLE_EXEMPT.has(x.p)))) return { pass: false, why: "excluded" };
  if (item.title.length < 12 || JUNK.some((r) => r.test(item.title))) return { pass: false, why: "junk" };
  if (item.publisher && BLOCKED_PUB.has(item.publisher.toLowerCase())) return { pass: false, why: "blocked publisher" };
  const kind = kindOf(item.src);
  const isMetal = kind === "metal" || category === "metal";
  const hasQ = QUAL.some((r) => r.test(text)) || (isMetal && METAL_QUAL.some((r) => r.test(text)));
  const headQ = QUAL.some((r) => r.test(head)) || (isMetal && METAL_QUAL.some((r) => r.test(head)));
  const m1 = [];
  const bands = [];
  for (const t of T1) {
    if (t.only_categories && !t.only_categories.includes(isMetal ? "metal" : category)) continue;
    if (t.require_horror && !HORROR.some((r) => r.test(text))) continue;
    if (t.res.some((r) => r.test(head)) && (!t.require_qualifier || hasQ)) {
      m1.push(t.name);
      if (t.only_categories && t.only_categories.includes("metal")) bands.push(t.name);
    }
  }
  const m2 = [];
  for (const t of T2) {
    if (t.require_horror && !HORROR.some((r) => r.test(text))) continue;
    if (t.res.some((r) => r.test(head)) && (headQ || (!isMetal && kind !== "metal"))) m2.push(t.name);
  }
  // each name once: the per-name cap counts these
  const matched = [...new Set([...m1, ...m2])];
  const t1count = new Set(m1).size;
  const era = ERA && ERA.test(head) && (!GENRE.length || GENRE.some((r) => r.test(text)));
  const label = METAL_LABELS.some((t) => t.res.some((r) => r.test(head)));

  if (isMetal) {
    const genre = METAL_GENRE.some((r) => r.test(text));
    if (!bands.length && !matched.length && !label && !genre) return { pass: false, why: "not our kind of metal" };
    const why = bands.length ? bands : matched.length ? matched : label ? ["metal label"] : ["metal genre"];
    // classic metal = a classic band, or a reissue / anniversary / box-set headline
    const metalClassic = bands.length > 0 || QUAL.some((r) => r.test(head));
    return { pass: true, category: "metal", matched: why, bands, keys: matched, classic: metalClassic, why: why.join(", ") };
  }
  const horror = HORROR.some((r) => r.test(text));
  // classic = a Tier 1 name, a period year with a horror word, or a collector word in the headline.
  // A franchise name alone (Tier 2) passes the story but doesn't make it classic.
  const classic = t1count > 0 || era || headQ;
  if (kind === "horror") return { pass: true, category, matched, bands: [], keys: matched, classic, why: matched.length ? matched.join(", ") : "horror outlet" };
  if (matched.length || horror) return { pass: true, category, matched, bands: [], keys: matched, classic, why: matched.length ? matched.join(", ") : "horror subject" };
  return { pass: false, why: "not horror" };
}

// ---------- normalise ----------
function canonical(u) {
  try {
    const x = new URL(u.trim());
    [...x.searchParams.keys()].forEach((k) => { if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) x.searchParams.delete(k); });
    x.hash = "";
    return x.toString().replace(/\/$/, "");
  } catch { return ""; }
}
const STOP = new Set("the and for with from that this its his her their will after into over about new says has have are was more than just".split(" "));
// crude stem (first five letters) so "retires" and "retirement" match
const words = (s) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.slice(0, 5)));
function sameStory(a, b) {
  const A = words(a), B = words(b); if (!A.size || !B.size) return false;
  let n = 0; A.forEach((w) => { if (B.has(w)) n++; });
  return n / Math.min(A.size, B.size) >= 0.6 || n >= 4;
}

// ---------- run ----------
const QUERY_SOURCES = (cfg.queries || []).map((q) => ({ name: `News search: ${q.q}`, category: q.category, query: q.q, weight: q.weight ?? 0.8, kind: q.kind || (q.category === "metal" ? "metal" : "general") }));
const WEIGHT_BY_NAME = Object.fromEntries(cfg.sources.map((x) => [x.name.toLowerCase(), x.weight]));
const results = await pool([...cfg.sources, ...QUERY_SOURCES], 8, fetchSource);
const cutoff = NOW.getTime() - cfg.freshness_days * 864e5;
const rows = [];
let candidates = [];

for (const { report, items } of results) {
  let fresh = 0, passed = 0;
  for (const it of items) {
    const t = Date.parse(it.date);
    const url = canonical(it.url);
    // low-frequency sources (author sites, presses) can ask for a longer window than the nightly 5 days
    const srcCut = it.src.freshness_days ? NOW.getTime() - it.src.freshness_days * 864e5 : cutoff;
    if (!it.title || !url || !Number.isFinite(t) || t < srcCut || t > NOW.getTime() + 36e5) continue;
    fresh++;
    const j = judge(it);
    if (!j.pass) continue;
    passed++;
    candidates.push({
      id: createHash("sha1").update(url).digest("hex"),
      title: it.title, source: (it.src.query && it.publisher) || it.src.name, url, category: j.category,
      published: new Date(t).toISOString(), snippet: snippetOf(it.snippet),
      matched: j.matched, classic: j.classic, why: j.why, amazon_query: null,
      _bands: j.keys || j.bands || [],
      _img: it.image || "",
      _w: (it.src.query && WEIGHT_BY_NAME[(it.publisher || "").toLowerCase()]) || it.src.weight || 1,
    });
  }
  rows.push({ ...report, fresh, passed });
}

// score: source weight x recency (half-life 2 days) x tier bonus
const HALF = 2 * 864e5;
candidates.forEach((c) => {
  const age = NOW.getTime() - Date.parse(c.published);
  c._s = c._w * Math.pow(0.5, age / HALF) * (c.classic ? (cfg.classic_boost ?? 1.6) : 1);
});
candidates.sort((a, b) => b._s - a._s);

// dedupe by URL, then by headline similarity (keep the higher-weight source)
const kept = [];
for (const c of candidates) {
  const dup = kept.find((k) => k.url === c.url || sameStory(k.title, c.title));
  if (!dup) kept.push(c);
  else if (c._w > dup._w) kept[kept.indexOf(dup)] = c;
}

// per-source cap, category balance, size
const perSource = {}, perCat = {}, perBand = {};
const maxCat = Math.ceil(cfg.max_items * cfg.max_category_share);
let picked = [], overflow = [];
for (const c of kept) {
  if ((perSource[c.source] || 0) >= cfg.per_source_cap) continue;
  // no more than two stories about the same band, franchise, writer or label per night
  if (c._bands.some((b) => (perBand[b] || 0) >= (cfg.per_band_cap ?? 2))) continue;
  perSource[c.source] = (perSource[c.source] || 0) + 1;
  c._bands.forEach((b) => { perBand[b] = (perBand[b] || 0) + 1; });
  if ((perCat[c.category] || 0) >= maxCat) { overflow.push(c); continue; }
  perCat[c.category] = (perCat[c.category] || 0) + 1;
  picked.push(c);
  if (picked.length >= cfg.max_items) break;
}
// if other categories ran dry, let the overflow back in
for (const c of overflow) { if (picked.length >= cfg.max_items) break; picked.push(c); }
// then hold each category to its share of what was actually published (min 3 items each)
const shareOf = (cat) => (cfg.category_share || {})[cat] ?? cfg.max_category_share;
for (;;) {
  const counts = {}; picked.forEach((c) => { counts[c.category] = (counts[c.category] || 0) + 1; });
  // a thin night shouldn't be starved further: balance only bites above the minimum wire size
  if (picked.length <= (cfg.balance_min_items ?? 20)) break;
  const over = Object.keys(counts).find((cat) => counts[cat] > 3 && counts[cat] > shareOf(cat) * picked.length);
  if (!over || Object.keys(counts).length === 1) break;
  const worst = picked.filter((c) => c.category === over).sort((a, b) => a._s - b._s)[0];
  picked.splice(picked.indexOf(worst), 1);
}

// Floors: some categories must show up every night (collectibles: figures, busts, statues, masks).
// Pull the best leftover candidates back in, making room by dropping the weakest story from a category that can spare one.
const floorNotes = [];
for (const [cat, min] of Object.entries(cfg.category_min || {})) {
  const have = () => picked.filter((c) => c.category === cat).length;
  const srcCount = (s) => picked.filter((c) => c.source === s).length;
  const bandCount = (b) => picked.filter((c) => c._bands.includes(b)).length;
  const pool = kept.filter((c) => c.category === cat && !picked.includes(c)).sort((a, b) => b._s - a._s);
  for (const c of pool) {
    if (have() >= min) break;
    if (srcCount(c.source) >= cfg.per_source_cap) continue;
    if (c._bands.some((b) => bandCount(b) >= (cfg.per_band_cap ?? 2))) continue;
    if (picked.length >= cfg.max_items) {
      const counts = {}; picked.forEach((x) => { counts[x.category] = (counts[x.category] || 0) + 1; });
      const victim = picked.filter((x) => x.category !== cat && counts[x.category] > Math.max(3, (cfg.category_min || {})[x.category] || 0)).sort((a, b) => a._s - b._s)[0];
      if (!victim) break;
      picked.splice(picked.indexOf(victim), 1);
    }
    picked.push(c);
  }
  floorNotes.push(`${cfg.categories?.[cat] || cat}: ${have()} (floor ${min})${have() < min ? " — BELOW FLOOR, not enough candidates tonight" : ""}`);
}
picked.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));

// ---------- Tonight's Lead image ----------
// One image, hotlinked from the publisher and credited on the page; never downloaded or hosted.
async function pageImage(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*" }, signal: ctl.signal, redirect: "follow" });
    if (!r.ok) return "";
    const html = (await r.text()).slice(0, 400000);
    const res = [
      /<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]*?content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["']og:image(?::secure_url)?["']/i,
      /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]*?content=["']([^"']+)["']/i,
    ];
    for (const re of res) { const m = html.match(re); if (m) return new URL(decodeEntities(m[1]), r.url || url).toString(); }
  } catch { /* no image */ } finally { clearTimeout(t); }
  return "";
}
// worth showing: https, not a site logo or placeholder, and really an image of some size
async function usableImage(u) {
  if (!/^https:\/\//i.test(u)) return false;
  if (/(logo|favicon|avatar|placeholder|gravatar|sprite|default[-_]?(image|share|og|thumb))/i.test(u)) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(u, { headers: { "user-agent": UA, range: "bytes=0-1023", accept: "image/*" }, signal: ctl.signal, redirect: "follow" });
    if (!(r.status === 200 || r.status === 206)) return false;
    if (!/^image\//i.test(r.headers.get("content-type") || "")) return false;
    const total = Number((r.headers.get("content-range") || "").split("/")[1]) || Number(r.headers.get("content-length")) || 0;
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return total === 0 || total >= 12000;
  } catch { return false; } finally { clearTimeout(t); }
}
const absUrl = (u, base) => { try { return new URL(decodeEntities(u), base).toString(); } catch { return ""; } };

// Tonight's Lead: horror, never metal; trusted source; a real snippet; classic if we have one;
// among the best few, the first one that has a usable image.
const NO_LEAD = new Set(cfg.lead?.exclude_categories || ["metal"]);
const base = picked.filter((c) => !NO_LEAD.has(c.category) && c._w >= (cfg.lead?.min_weight ?? 0.8) && c.snippet);
const classicBase = base.filter((c) => c.classic);
const leadPool = [...(classicBase.length ? classicBase : base.length ? base : picked.filter((c) => !NO_LEAD.has(c.category)))].sort((a, b) => b._s - a._s);
let lead = null;
for (const c of leadPool.slice(0, cfg.lead?.image_tries ?? 6)) {
  let img = c._img ? absUrl(c._img, c.url) : "";
  if (!img || !(await usableImage(img))) { img = await pageImage(c.url); if (img && !(await usableImage(img))) img = ""; }
  if (img) { lead = { ...c, image: img }; break; }
}
if (!lead) lead = leadPool[0] || null;

// Keeper's Desk: tonight's file, or the most recent one before it
async function desk() {
  const dir = path("content/desk/");
  if (!existsSync(dir)) return null;
  const files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) <= TONIGHT).sort();
  if (!files.length) return null;
  const f = files[files.length - 1];
  const d = JSON.parse(await readFile(new URL(f, dir), "utf8"));
  return { date: f.slice(0, 10), takes: d.takes || [] };
}

const strip = ({ _w, _s, _bands, _img, ...rest }) => rest;
const out = {
  built_at: NOW.toISOString(),
  built_for: TONIGHT,
  lead: lead ? strip(lead) : null,
  items: picked.map(strip),
  desk: await desk(),
};

// ---------- report ----------
const ok = rows.filter((r) => r.fetched > 0);
const summary = [
  `## Night Wire — ${CHECK ? "feed check" : "build"} for ${TONIGHT}`,
  "",
  `Sources: ${rows.length} · reachable: ${ok.length} · direct feeds: ${rows.filter((r) => r.via === "feed").length} · Google News fallback: ${rows.filter((r) => r.via === "google-news").length} · unreachable: ${rows.length - ok.length}`,
  `Candidates passing the taxonomy: ${candidates.length} · after dedupe: ${kept.length} · published: ${picked.length}`,
  lead ? `Tonight's Lead: ${lead.title} (${lead.source})` : "Tonight's Lead: none",
  lead ? `Lead image: ${lead.image || "none found (the page shows its cover plate)"}` : "",
  ...floorNotes.map((n) => `Floor — ${n}`),
  "",
  "| Source | Via | Fetched | Fresh (≤" + cfg.freshness_days + "d) | Passed | Error |",
  "|---|---|---:|---:|---:|---|",
  ...rows.sort((a, b) => a.name.localeCompare(b.name)).map((r) => `| ${r.name} | ${r.via || "—"} | ${r.fetched} | ${r.fresh} | ${r.passed} | ${r.error.replace(/\|/g, "/")} |`),
  "",
  "### Tonight's items",
  "",
  "| Category | Source | Headline | Why it passed |",
  "|---|---|---|---|",
  ...picked.map((c) => `| ${c.category} | ${c.source} | ${c.title.replace(/\|/g, "/")} | ${c.why}${c.classic ? " · classic" : ""} |`),
];
console.log(summary.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n", { flag: "a" });

if (CHECK) process.exit(0);

if (picked.length < 8) {
  console.error(`Only ${picked.length} items passed. Keeping last night's wire rather than publishing a thin one.`);
  process.exit(0);
}
await mkdir(new URL(".", OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${picked.length} items to site/data/wire.json`);
