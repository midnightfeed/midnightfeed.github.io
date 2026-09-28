# The Midnight Feed

Source for [midnightfeed.net](https://midnightfeed.net) — a nightly news wire for collectors of vintage horror: pulps and paperbacks, Warren comics, classic horror film, boutique reissues and classic metal.

Original articles and the podcast are produced by AI editorial personas, disclosed on every page. Wire headlines link to their original publishers and are not rewritten.

## Layout

| Path | What it is |
|---|---|
| `site/` | Everything published. GitHub Pages serves this folder. |
| `site/index.html` | The site. |
| `site/assets/` | Favicons and the social share image. |
| `content/` | Articles, Keeper's Desk takes and episode metadata (later phases). |
| `config/taxonomy.json` | What the Night Wire includes and excludes. |
| `scripts/` | Build scripts (later phases). |
| `.github/workflows/deploy.yml` | Publishes `site/` on every push to `main`. |

## Deploying

Push to `main`. The **Deploy site** workflow publishes `site/` to GitHub Pages.
