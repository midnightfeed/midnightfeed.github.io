#!/usr/bin/env node
// Builds The Archive from content/articles/*.md:
//   site/archive/<slug>/index.html   one page per article
//   site/archive/index.html          the Archive index
//   site/archive/feed.xml            article RSS
//   site/sitemap.xml
//   site/index.html                  "This Week's Article" module (between build markers)
//
// Every page reuses the header, footer, head tags and stylesheet of site/index.html,
// read from its <!-- shell:… --> markers, so the design has one source.
//
// An article publishes at 00:00 Central on its `date`. Earlier builds skip it, and
// `draft: true` skips it always. Run on every push and every nightly build.
//
//   node scripts/build-pages.mjs            build
//   node scripts/build-pages.mjs --check    validate only, write nothing
//
// An article with an error is skipped and listed in the run summary; it never stops the deploy.

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { marked } from "marked";
import yaml from "js-yaml";

const SITE = "https://midnightfeed.net";
const AMZ_TAG = "midnightfeed-20";
const ROOT = new URL("..", import.meta.url).pathname;
const CHECK = process.argv.includes("--check");
const CATNAME = {
  books: "Books &amp; Pulps", comics: "Comics", film: "Film",
  discs: "Discs &amp; Vinyl", gear: "Gear", metal: "Metal", collect: "Collecting",
};
const REQUIRED = ["title", "slug", "dek", "date", "kicker", "category", "byline", "description"];

const report = [];
const problems = [];
const warn = (m) => report.push("⚠️ " + m);

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s) => marked.parseInline(String(s ?? "")).trim();
const amz = (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}&i=stripbooks&tag=${AMZ_TAG}`;

function chicagoToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}
function ymd(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}
function asDate(s) { return new Date(s + "T12:00:00Z"); }
function fmt(s, opts) { return asDate(s).toLocaleDateString("en-GB", { timeZone: "UTC", ...opts }); }
const longDate = (s) => fmt(s, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(/^(\w+) /, "$1, ");
const shortDate = (s) => fmt(s, { day: "numeric", month: "short" });
const indexDate = (s) => fmt(s, { day: "numeric", month: "short", year: "numeric" });
const weekday = (s) => fmt(s, { weekday: "long" });
// 00:00 Central on the publication day, as UTC (CDT is UTC-5, CST is UTC-6)
function publishedISO(s) {
  for (const off of [5, 6]) {
    const t = new Date(`${s}T${String(off).padStart(2, "0")}:00:00Z`);
    const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23" }).format(t);
    if (h === "00") return t.toISOString().replace(".000Z", "Z");
  }
  return `${s}T05:00:00Z`;
}

function between(src, name) {
  const a = `<!-- ${name} -->`, b = `<!-- /${name} -->`;
  const i = src.indexOf(a), j = src.indexOf(b);
  if (i < 0 || j < i) throw new Error(`site/index.html is missing the ${name} markers`);
  return src.slice(i + a.length, j).replace(/^\n|\n$/g, "");
}

// ---------- read the shell ----------
const indexPath = ROOT + "site/index.html";
const indexSrc = await readFile(indexPath, "utf8");
const shell = {
  reset: indexSrc.match(/<style>([^<]*)<\/style>/)[1],
  head: between(indexSrc, "shell:head"),
  css: between(indexSrc, "shell:css"),
  top: between(indexSrc, "shell:top"),
  foot: between(indexSrc, "shell:foot"),
  analytics: between(indexSrc, "shell:analytics"),
};
// On Archive pages the Archive tab is current; the Wire tab is a plain link home.
shell.top = shell.top
  .replace(/ aria-current="page"/g, "")
  .replace(/ data-nav="(home|pod)"/g, "")
  .replace('<a href="/archive/">The Archive</a>', '<a href="/archive/" aria-current="page">The Archive</a>');
shell.foot = shell.foot.replace(/ data-nav="(home|pod)"/g, "");

// ---------- read the articles ----------
const dir = ROOT + "content/articles/";
const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
const today = chicagoToday();
const all = [];
for (const f of files) {
  const raw = (await readFile(dir + f, "utf8")).replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) { problems.push(`${f}: no frontmatter block`); continue; }
  let fm;
  try { fm = yaml.load(m[1]); } catch (e) { problems.push(`${f}: frontmatter is not valid YAML (${e.message.split("\n")[0]})`); continue; }
  fm.date = ymd(fm.date);
  const missing = REQUIRED.filter((k) => !fm[k]);
  if (missing.length) { problems.push(`${f}: missing ${missing.join(", ")}`); continue; }
  const bad = [];
  if (fm.slug !== f.replace(/\.md$/, "")) bad.push(`${f}: slug "${fm.slug}" must match the file name`);
  if (!/^[a-z0-9-]+$/.test(fm.slug)) bad.push(`${f}: slug may use only a-z, 0-9 and hyphens`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fm.date)) bad.push(`${f}: date must be YYYY-MM-DD`);
  if (!CATNAME[fm.category]) bad.push(`${f}: unknown category "${fm.category}"`);
  if (weekday(fm.date) !== "Friday") warn(`${f}: ${fm.date} is a ${weekday(fm.date)}, not a Friday`);
  if (fm.description.length > 155) warn(`${f}: description is ${fm.description.length} characters (155 max)`);
  for (const code of m[2].match(/\{\{[^}]*\}\}/g) || []) {
    if (!["{{figures}}", "{{pullquote}}", "{{affiliate}}"].includes(code)) bad.push(`${f}: unknown shortcode ${code}`);
  }
  if (m[2].includes("{{figures}}") && !(fm.figures || []).length) bad.push(`${f}: {{figures}} used but no figures listed`);
  if (m[2].includes("{{pullquote}}") && !fm.pullquote) bad.push(`${f}: {{pullquote}} used but no pullquote given`);
  if (m[2].includes("{{affiliate}}") && !(fm.affiliate || []).length) bad.push(`${f}: {{affiliate}} used but no affiliate items`);
  if (bad.length) { problems.push(...bad); continue; }
  all.push({ ...fm, body: m[2], file: f });
}
// A broken article is skipped and reported; the rest of the site (and the night's wire) still deploys.
for (const p of problems) report.push("❌ Not published — " + p);
if (problems.length) console.error("Skipped articles with errors:\n  " + problems.join("\n  "));


const byNewest = (a, b) => (b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
const live = all.filter((a) => !a.draft && a.date <= today).sort(byNewest);
const waiting = all.filter((a) => a.draft || a.date > today).sort(byNewest);
for (const a of waiting) report.push(`Waiting: “${a.title}” — ${a.draft ? "draft" : "publishes " + longDate(a.date) + " at 00:00 CT"}`);

// ---------- pieces ----------
const url = (a) => `${SITE}/archive/${a.slug}/`;
const coverHTML = (c) =>
  `<div class="cover"${c.cover ? ` data-cover="${esc(c.cover)}"` : ""} style="--c1:${esc(c.c1 || "#2E3F55")};--c2:${esc(c.c2 || "#0D1119")}"><div class="c-imprint">${esc(c.imprint || "")}</div><div><div class="c-title">${esc(c.title)}</div><div class="c-author">${esc(c.author || "")}</div></div></div>`;
const affItem = (b) =>
  `<li><a href="${esc(amz(b.query || `${b.title} ${b.author || ""}`))}" target="_blank" rel="noopener sponsored"><span class="t">${esc(b.title)}</span><span class="m">${esc(b.author || "")} &middot; ${esc(b.note || "")}</span></a></li>`;

function renderBody(a) {
  const parts = a.body.split(/^\s*(\{\{(?:figures|pullquote|affiliate)\}\})\s*$/m);
  return parts.map((p) => {
    if (p === "{{figures}}") {
      return `<div class="figrow">\n  ${a.figures.map(coverHTML).join("\n  ")}\n  ${a.figcaption ? `<figcaption>${inline(a.figcaption)}</figcaption>` : ""}\n</div>`;
    }
    if (p === "{{pullquote}}") return `<blockquote class="pullquote">${inline(a.pullquote)}</blockquote>`;
    if (p === "{{affiliate}}") {
      return `<div class="inline-cta">\n  ${a.affiliate_intro ? `<p>${inline(a.affiliate_intro)}</p>` : ""}\n  <ul class="afflist">${a.affiliate.map(affItem).join("")}</ul>\n</div>`;
    }
    return marked.parse(p).trim();
  }).filter(Boolean).join("\n\n");
}

function indexItem(a, withKicker) {
  return `<li><span class="when">${esc(withKicker ? indexDate(a.date) : shortDate(a.date))}</span><div>${withKicker ? `<span class="kicker">${esc(a.kicker)}</span>` : ""}<h4><a href="/archive/${a.slug}/">${inline(a.title)}</a></h4><p>${inline(a.summary || a.dek)}</p></div></li>`;
}

const KEEPER = `<div class="keeper" style="margin-top:36px;padding-top:22px;border-top:var(--rule-w) solid var(--rule)">
  <div class="sigil">DG</div>
  <p><span class="who">About Doug Graves</span>Doug Graves is the Stacks Keeper &mdash; resident intelligence of The Midnight Feed, and an AI editorial persona rather than a person. He reads roughly fifty sources a night, writes one article a week, co-hosts <em>The Pod People</em> with Anita Coffin, and has never once returned a book on time. Corrections are welcome and acted on.</p>
</div>`;

const NIGHT_MAIL = `<section class="mod paper signup">
  <h2 class="dept">The Night Mail</h2>
  <div class="mod-body">
    <p style="margin:0 0 12px">Coming soon: one letter a week &mdash; the article, five stories off the wire, and a cover from the archive.</p>
    <a class="btn" href="https://x.com/midnightfeeders" target="_blank" rel="noopener me">Follow on X for the launch &#8599;</a>
  </div>
</section>`;
const RAIL_AD = `<div class="adslot" style="min-height:180px">
  <span class="kicker">Sponsor &mdash; 300&times;250</span>
  <span class="price"><a href="mailto:midnightfeed.net@gmail.com?subject=Advertising%20on%20The%20Midnight%20Feed">Small press? This slot is yours &rarr;</a></span>
</div>`;

function page({ title, description, canonical, ogType, extraHead = "", main }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>${shell.reset}</style>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
${shell.head}
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="The Midnight Feed">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}/assets/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The Midnight Feed wordmark">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@midnightfeeders">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}/assets/og-image.png">
${extraHead}${shell.css}
</head>
<body>
${shell.top}
  <main class="wrap">
${main}
  </main>

${shell.foot}
<script src="/assets/pages.js" defer></script>
${shell.analytics}
</body>
</html>
`;
}

const ldJSON = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>\n`;
const plain = (s) => String(s).replace(/<[^>]+>/g, "").replace(/\*\*?|__?/g, "");

// ---------- article pages ----------
const out = {};
for (const a of live) {
  const others = live.filter((o) => o !== a).slice(0, 6);
  const corrections = (a.corrections || []).length
    ? `\n<div class="corrections"><span class="kicker">Corrections</span>${a.corrections.map((c) =>
        `<p><strong>${esc(c.date ? indexDate(ymd(c.date)) : "")}.</strong> ${inline(c.text || c)}</p>`).join("")}</div>`
    : "";
  const main = `    <section class="page">
      <div class="article-cols">
        <div>
          <article class="article">
            <span class="kicker">The Archive &middot; ${esc(a.kicker)}</span>
            <h1>${inline(a.title)}</h1>
            <p class="deck">${inline(a.dek)}</p>
            <div class="byline-row">
              <span class="kicker">By ${esc(a.byline)}</span>
              <span class="tag" data-cat="${a.category}">${CATNAME[a.category]}</span>
              <span class="kicker"><time datetime="${a.date}">${longDate(a.date)}</time></span>
            </div>
            <div class="sharerow"><a class="sharex" data-share-text="${esc(a.share_text || a.title)}" data-share-url="${url(a)}">Share on &#120143;</a><span class="kicker" style="color:var(--muted)">By Doug Graves</span></div>

${renderBody(a)}${corrections}
          </article>

          ${KEEPER}
${others.length ? `
          <h2 class="dept" style="margin-top:44px">Also in the Archive</h2>
          <ul class="artindex">
            ${others.map((o) => indexItem(o, false)).join("\n            ")}
          </ul>
          <p style="margin:18px 0 0"><a class="btn btn-ghost" style="line-height:normal" href="/archive/">Every article &rarr;</a></p>` : ""}
        </div>

        <aside>
${(a.affiliate || []).length ? `          <section class="mod">
            <h2 class="dept">Find These Books</h2>
            <div class="mod-body">
              <ul class="afflist">${a.affiliate.map(affItem).join("")}</ul>
              <p class="affnote">Affiliate links. The Midnight Feed earns a commission on qualifying purchases, at no cost to you.</p>
            </div>
          </section>
` : ""}          ${NIGHT_MAIL}
          ${RAIL_AD}
        </aside>
      </div>
    </section>`;
  out[`site/archive/${a.slug}/index.html`] = page({
    title: `${plain(a.title)} — The Midnight Feed`,
    description: a.description,
    canonical: url(a),
    ogType: "article",
    extraHead: `<meta property="article:published_time" content="${publishedISO(a.date)}">\n<meta property="article:section" content="${esc(a.kicker)}">\n` +
      ldJSON({
        "@context": "https://schema.org", "@type": "Article",
        headline: plain(a.title), description: a.description,
        datePublished: publishedISO(a.date),
        ...(a.updated ? { dateModified: publishedISO(ymd(a.updated)) } : {}),
        mainEntityOfPage: url(a), image: `${SITE}/assets/og-image.png`,
        // Doug Graves is an AI persona, not a person: credit the publication.
        author: { "@type": "Organization", name: "The Midnight Feed", url: SITE + "/" },
        publisher: { "@type": "Organization", name: "The Midnight Feed", url: SITE + "/", logo: { "@type": "ImageObject", url: `${SITE}/assets/favicon-192.png` } },
      }),
    main,
  });
}

// ---------- the Archive index ----------
out["site/archive/index.html"] = page({
  title: "The Archive — The Midnight Feed",
  description: "Long-form articles on vintage horror — writers, imprints, comics, film and the collecting of all of it. A new piece every Friday.",
  canonical: `${SITE}/archive/`,
  ogType: "website",
  extraHead: ldJSON({
    "@context": "https://schema.org", "@type": "CollectionPage", name: "The Archive", url: `${SITE}/archive/`,
    isPartOf: { "@type": "WebSite", name: "The Midnight Feed", url: SITE + "/" },
    hasPart: live.map((a) => ({ "@type": "Article", headline: plain(a.title), url: url(a), datePublished: publishedISO(a.date) })),
  }),
  main: `    <section class="page">
      <div class="article-cols">
        <div>
          <div class="hero-strip">
            <span class="kicker">The Archive</span>
            <h1>One long piece, every Friday</h1>
            <p>Writers, imprints, comics, film and the business of collecting them, by Doug Graves, the Stacks Keeper. The facts are checked against sources before anything runs, and corrections are dated at the foot of the piece.</p>
          </div>

          <h2 class="dept" style="margin-top:40px">Every Article</h2>
${live.length ? `          <ul class="artindex">
            ${live.map((a) => indexItem(a, true)).join("\n            ")}
          </ul>` : `          <p style="color:var(--dim)">The first article publishes on Friday.</p>`}

          ${KEEPER}
        </div>

        <aside>
          ${NIGHT_MAIL}
          ${RAIL_AD}
        </aside>
      </div>
    </section>`,
});

// ---------- RSS ----------
const rssDate = (s) => new Date(publishedISO(s)).toUTCString();
const xml = (s) => esc(plain(s));
out["site/archive/feed.xml"] = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>The Archive — The Midnight Feed</title>
<link>${SITE}/archive/</link>
<atom:link href="${SITE}/archive/feed.xml" rel="self" type="application/rss+xml"/>
<description>A long-form article on vintage horror every Friday. Written by Doug Graves, the Stacks Keeper — an AI editorial persona, not a person.</description>
<language>en</language>
${live[0] ? `<lastBuildDate>${rssDate(live[0].date)}</lastBuildDate>\n` : ""}${live.map((a) => `<item>
<title>${xml(a.title)}</title>
<link>${url(a)}</link>
<guid isPermaLink="true">${url(a)}</guid>
<pubDate>${rssDate(a.date)}</pubDate>
<dc:creator>Doug Graves, the Stacks Keeper (AI persona)</dc:creator>
<category>${xml(a.kicker)}</category>
<description>${xml(a.dek)}</description>
</item>`).join("\n")}
</channel>
</rss>
`;

// ---------- sitemap ----------
const newest = live[0]?.date;
out["site/sitemap.xml"] = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE}/</loc><changefreq>daily</changefreq></url>
<url><loc>${SITE}/archive/</loc>${newest ? `<lastmod>${newest}</lastmod>` : ""}<changefreq>weekly</changefreq></url>
${live.map((a) => `<url><loc>${url(a)}</loc><lastmod>${ymd(a.updated || a.date)}</lastmod></url>`).join("\n")}
</urlset>
`;

// ---------- home: This Week's Article ----------
const lead = live[0];
let home = indexSrc;
if (lead) {
  const block = `<!-- build:this-week -->
          <section class="mod">
            <h2 class="dept">This Week's Article</h2>
            <div class="mod-body">
              <span class="kicker">${fmt(lead.date, { weekday: "long", day: "numeric", month: "long" })} &middot; ${esc(lead.kicker)}</span>
              <h4 style="margin:8px 0 8px;font-family:var(--f-display);font-size:19px;line-height:1.18">${inline(lead.title)}</h4>
              <p style="margin:0 0 14px;font-size:15.5px;color:var(--dim)">${inline(lead.summary || lead.dek)}</p>
              <a class="btn btn-ghost" style="line-height:normal" href="/archive/${lead.slug}/">Read it</a>
            </div>
          </section>
<!-- /build:this-week -->`;
  home = indexSrc.replace(/<!-- build:this-week -->[\s\S]*?<!-- \/build:this-week -->/, block);
}

// ---------- write ----------
report.unshift(`Published: ${live.length} article${live.length === 1 ? "" : "s"}${lead ? ` · This Week's Article: “${plain(lead.title)}” (${lead.date})` : ""}`);
if (!CHECK) {
  await rm(ROOT + "site/archive", { recursive: true, force: true });
  for (const [p, html] of Object.entries(out)) {
    await mkdir(ROOT + p.replace(/[^/]+$/, ""), { recursive: true });
    await writeFile(ROOT + p, html);
  }
  if (home !== indexSrc) await writeFile(indexPath, home);
}
console.log((CHECK ? "[check] " : "") + report.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, "\n## The Archive\n\n" + report.map((r) => "- " + r).join("\n") + "\n", { flag: "a" });
}
