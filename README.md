# The Midnight Feed

Source for [midnightfeed.net](https://midnightfeed.net) — a nightly news wire for collectors of vintage horror: pulps and paperbacks, Warren comics, classic horror film, boutique reissues and classic metal.

Original articles and the podcast are produced by AI editorial personas, disclosed on every page. Wire headlines link to their original publishers and are not rewritten.

## Layout

| Path | What it is |
|---|---|
| `site/` | Everything published. GitHub Pages serves this folder. |
| `site/index.html` | The home page: the Night Wire and the Pod People. Its `shell:` markers supply the header, footer and head tags for every other page. |
| `site/assets/site.css`, `logo.png`, `pages.js` | The shared stylesheet, the wordmark, and the script for Archive pages. |
| `site/archive/`, `site/sitemap.xml` | Built on GitHub from `content/articles/`; not committed. |
| `site/assets/` | Favicons and the social share image. |
| `content/articles/` | Archive articles, one Markdown file each. An article publishes at 00:00 Central on its `date`. |
| `content/desk/` | Keeper's Desk bites, one file per release day. |
| `content/episodes/` | Podcast episode metadata (later). |
| `config/taxonomy.json` | What the Night Wire includes and excludes. |
| `scripts/build-wire.mjs` | Builds the Night Wire into `site/data/wire.json`. |
| `scripts/build-pages.mjs` | Builds the Archive: one page per article, the Archive index, the article RSS feed, the sitemap, and the home page's This Week's Article. |
| `.github/workflows/build-and-deploy.yml` | Rebuilds the wire at midnight Central, builds the Archive, and publishes `site/`; also builds and publishes on every push to `main`. |
| `.github/workflows/feed-check.yml` | Manual check of every wire source. Changes nothing. |

## Deploying

Push to `main` and **Build and deploy** publishes `site/` to GitHub Pages. To rebuild the wire immediately, run **Build and deploy** from the Actions tab.

## Publishing an article

Add `content/articles/<slug>.md` (frontmatter and shortcodes as in the existing articles) and push. It goes live at 00:00 Central on its `date`; `draft: true` holds it back. The run summary lists what was published, what is waiting, and any article skipped for an error.
