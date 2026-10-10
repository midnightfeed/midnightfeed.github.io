// Fetch cover images for the Archive from Open Library.
// Reads content/covers.json, finds the edition matching each request's imprint (and year, if given),
// downloads its cover to site/assets/covers/<key>.jpg and records it in site/assets/covers/manifest.json.
// New covers are saved with "verified": false and are NOT shown on the site until someone checks
// the image against the edition the article names and sets "verified": true.
//
//   node scripts/fetch-covers.mjs          fetch covers that are missing
//   FORCE=1 node scripts/fetch-covers.mjs  re-fetch everything (keeps nothing verified)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const path = (p) => new URL(p, ROOT);
const UA = "TheMidnightFeed/1.0 (midnightfeed.net@gmail.com)";
const FORCE = process.env.FORCE === "1";
const OUTDIR = path("site/assets/covers/");
const MANIFEST = path("site/assets/covers/manifest.json");

const req = JSON.parse(await readFile(path("content/covers.json"), "utf8")).covers;
const manifest = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, "utf8")) : {};
await mkdir(OUTDIR, { recursive: true });

async function getJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const report = [];
for (const c of req) {
  if (!FORCE && manifest[c.key]?.file && existsSync(new URL(manifest[c.key].file, OUTDIR))) {
    report.push(`| ${c.key} | kept | ${manifest[c.key].publisher} ${manifest[c.key].date} | ${manifest[c.key].verified ? "verified" : "awaiting check"} |`);
    continue;
  }
  try {
    const q = `https://openlibrary.org/search.json?title=${encodeURIComponent(c.title)}&author=${encodeURIComponent(c.author)}&limit=5&fields=key,title`;
    const works = (await getJSON(q)).docs || [];
    let best = null;
    for (const w of works) {
      await sleep(400);
      const eds = (await getJSON(`https://openlibrary.org${w.key}/editions.json?limit=200`)).entries || [];
      for (const e of eds) {
        const pubs = (e.publishers || []).map(norm).join(" | ");
        if (!pubs.includes(norm(c.imprint))) continue;
        if (!(e.covers || []).some((id) => id > 0)) continue;
        const yearOk = !c.year || String(e.publish_date || "").includes(c.year);
        const score = (yearOk ? 2 : 0) + (c.year ? 0 : 1);
        if (c.year && !yearOk) continue;
        if (!best || score > best.score) best = { e, score, work: w.key };
      }
      if (best) break;
    }
    if (!best) { report.push(`| ${c.key} | no matching edition with a cover | — | keep the plate |`); continue; }
    const id = best.e.covers.find((x) => x > 0);
    await sleep(400);
    const img = await fetch(`https://covers.openlibrary.org/b/id/${id}-L.jpg`, { headers: { "user-agent": UA } });
    const buf = Buffer.from(await img.arrayBuffer());
    if (!img.ok || buf.length < 3000) { report.push(`| ${c.key} | cover image missing or blank | — | keep the plate |`); continue; }
    const file = `${c.key}.jpg`;
    await writeFile(new URL(file, OUTDIR), buf);
    manifest[c.key] = {
      file, title: c.title, imprint: c.imprint,
      publisher: (best.e.publishers || []).join(", "), date: best.e.publish_date || "",
      edition: `https://openlibrary.org${best.e.key}`, cover_id: id, verified: false,
    };
    report.push(`| ${c.key} | fetched | ${manifest[c.key].publisher} ${manifest[c.key].date} | awaiting check |`);
  } catch (err) {
    report.push(`| ${c.key} | error: ${err.message} | — | keep the plate |`);
  }
}
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

const summary = ["## Archive covers", "", "| Cover | Result | Edition found | Status |", "|---|---|---|---|", ...report].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n", { flag: "a" });
