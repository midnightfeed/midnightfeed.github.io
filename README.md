# The Midnight Feed

Source for [midnightfeed.net](https://midnightfeed.net) — a nightly news wire for collectors of vintage horror: pulps and paperbacks, Warren comics, classic horror film, boutique reissues and classic metal.

Original articles and the podcast are produced by AI editorial personas, disclosed on every page. Wire headlines link to their original publishers and are not rewritten.

## Layout

| Path | What it is |
|---|---|
| `site/` | Everything published. GitHub Pages serves this folder. |
| `site/index.html` | The site. |
| `site/assets/` | Favicons and the social share image. |
| `content/desk/` | Keeper's Desk takes, one file per night. |
| `content/` | Articles and episode metadata (later phases). |
| `config/taxonomy.json` | What the Night Wire includes and excludes. |
| `scripts/build-wire.mjs` | Builds the Night Wire into `site/data/wire.json`. |
| `.github/workflows/build-and-deploy.yml` | Rebuilds the wire at midnight Central and publishes `site/`; also publishes on every push to `main`. |
| `.github/workflows/feed-check.yml` | Manual check of every wire source. Changes nothing. |

## Deploying

Push to `main` and **Build and deploy** publishes `site/` to GitHub Pages. To rebuild the wire immediately, run **Build and deploy** from the Actions tab.
