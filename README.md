# Techno Feed

A static site on GitHub Pages that shows recent posts from the Instagram pages you follow,
in plain reverse-chronological order, with promotional posts marked but never hidden.

**You never log into Instagram or Facebook.** A scheduled GitHub Action pulls the posts once a
day, mirrors the thumbnails into the repo, and redeploys the site.

```
┌──────────────┐   daily cron   ┌──────────────┐   posts+images   ┌───────────────┐
│ GitHub Action│ ─────────────► │ Apify actor  │ ───────────────► │ data branch   │
│  fetch.mjs   │                │ (residential │                  │ feed.json +   │
└──────────────┘                │  proxies)    │                  │ media/*.jpg   │
       │                        └──────────────┘                  └───────────────┘
       └────────────────── assemble + deploy ──────────────────────►  GitHub Pages
```

---

## Why it works this way

Worth knowing before you change anything, because each of these is a dead end I checked:

- **Meta's official APIs cannot do this.** They only reach accounts that have authorized *your*
  app. `business_discovery` returns follower counts and bios, not a usable post feed.
- **RSS-Bridge / RSSHub Instagram routes cannot do this.** They are chronically broken, and the
  configurations that do work need a logged-in Instagram session — which defeats the point.
- **You cannot scrape Instagram from a GitHub runner.** Instagram blocks datacenter IPs; you get
  login-walled within a request or two. The scraping has to happen somewhere with residential
  proxies, which is the entire reason a third-party actor is in the loop.
- **Instagram's own injected ads are not a problem here.** Those only exist in the algorithmic
  feed. Pulling a specific page's timeline returns only that page's posts, so the only "ads"
  left are the page's own promo posts — which is what the promo scoring handles.
- **Instagram CDN image URLs expire** (`403 URL signature expired`). Thumbnails have to be
  copied into the repo or the site rots into broken images within days.

---

## Setup

### 1. Get a free Apify token

No credit card. The free plan is permanent and includes **$5 of usage per month**.

1. Sign up at [apify.com](https://apify.com).
2. **Settings → API & Integrations → Personal API token**, copy it.

### 2. Create the repo

`gh` is not installed on this machine, so via the web UI:

1. [github.com/new](https://github.com/new) → name it `techno-feed` → **Public** → Create.
   (Public is required for free GitHub Pages. See [Privacy](#privacy) below.)
2. Push this directory:
   ```bash
   git remote add origin https://github.com/<your-username>/techno-feed.git
   git branch -M main
   git push -u origin main
   ```

### 3. Add the token as a secret

**Settings → Secrets and variables → Actions → New repository secret**
Name it exactly `APIFY_TOKEN`, paste the value.

### 4. Turn on Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions**
(Not "Deploy from a branch" — the workflow uploads the site as an artifact.)

### 5. Add your pages and run it

Edit [`sources.json`](sources.json), replacing the two placeholders with the accounts you
actually follow:

```json
{
  "postsPerSource": 6,
  "maxStoredPosts": 300,
  "sources": [
    { "handle": "hoerberlin", "name": "Hör Berlin" }
  ]
}
```

`handle` is the username from the profile URL, without the `@`. Commit and push, then go to
**Actions → Update feed → Run workflow**. The first run populates the site; after that it runs
itself daily at ~07:17 UTC.

Your feed lives at `https://<your-username>.github.io/techno-feed/`. On your phone, use
Share → Add to Home Screen and it behaves like an app.

---

## Cost

The actor is priced per query and per post, so cost scales with sources × cadence:

| Setup | Per day | Per month | vs $5 free credits |
|---|---|---|---|
| 10 sources, 6 posts, 1×/day | $0.08 | **~$2.40** | comfortable |
| 10 sources, 6 posts, 2×/day | $0.16 | ~$4.80 | at the ceiling |
| 20 sources, 6 posts, 1×/day | $0.16 | ~$4.80 | at the ceiling |

**Stay at one run per day** unless you are willing to pay. Credits do not roll over, and Apify
simply blocks runs once they are spent — at which point the site keeps serving the last good
data behind a staleness banner. To go faster, change the `cron` line in
[`.github/workflows/update.yml`](.github/workflows/update.yml).

---

## Promo marking

Posts are scored 0–3 in [`scripts/promo.mjs`](scripts/promo.mjs) and shown with a `PROMO` chip —
**hover it to see exactly why it was flagged**. Nothing is hidden unless you tick "Hide promo".

| Score | Trigger |
|---|---|
| 3 | Instagram's own paid-partnership flag, or several weaker signals stacked |
| 1–2 | Caption keywords: tickets, presale, link in bio, giveaway, discount, `#ad`, … |
| +1 | More than 12 hashtags |

Keywords are matched in English, Italian, German and Spanish, since techno pages are mostly
European — `prevendite aperte` and `Vorverkauf` get caught, not just `presale`.

To tune it, edit `PROMO_PATTERNS` and run `node scripts/test-promo.mjs`. The whole backlog is
re-scored on the next fetch, so changes apply retroactively rather than only to new posts.

---

## If it breaks

**The most likely failure is the actor changing or being delisted.** All actor-specific field
mapping lives in [`scripts/normalize.mjs`](scripts/normalize.mjs) — nothing else touches a raw
field name, so swapping is a one-file change.

Current actor: `apidojo~instagram-scraper` (input `startUrls` + `maxItems`; output `id`, `code`,
`url`, `createdAt`, `caption`, `owner.username`, `image.url`, `isPaidPartnership`).

Drop-in alternates, and how they differ:

| Actor | Differences to handle in `normalize.mjs` |
|---|---|
| `apify~instagram-scraper` | Input uses `directUrls` + `resultsLimit`. Output uses `timestamp` (not `createdAt`), `displayUrl` (not `image.url`), `ownerUsername` (flat, not `owner.username`), and provides a `hashtags` array. |
| `netdesignr~instagram-posts-scraper-pro` | Output uses `publishedAt`, `media[]`, `ownerUsername`, and exposes **both** `isSponsored` and `isPaidPartnership`. |

Other failures:

| Symptom | Cause and fix |
|---|---|
| Workflow red, site still shows old posts | Working as designed. Read the error in the log. |
| `Apify 402` | Monthly credits spent. Wait for the reset or reduce `postsPerSource`/cadence. |
| `Apify 401` | `APIFY_TOKEN` secret missing, wrong, or revoked. |
| "No feed data yet" on the site | The first run has not succeeded. Check Actions. |
| Run finished as `FAILED` | Open the Apify console link in the log — usually the actor itself. |
| Scheduled runs stopped after ~2 months | GitHub disables cron after 60 days with no commits. The daily data commit normally prevents this; if every page went silent, hit **Run workflow** to re-arm it. |
| A page's posts never appear | Private account, or a typo in `handle`. `normalize.mjs` deliberately drops posts from accounts not listed in `sources.json`. |

---

## Local development

No dependencies to install — everything uses built-in Node (v24) and plain browser JS.

```bash
node scripts/test-promo.mjs          # offline tests: scorer + actor adapter
node scripts/make-fixture.mjs        # fake store, no token, no credits spent
node scripts/make-fixture.mjs --stale  # backdated, to see the staleness banner

# preview exactly what gets deployed
mkdir -p _site && cp index.html app.js style.css icon.svg manifest.webmanifest robots.txt _site/
cp -r store/. _site/ && (cd _site && python3 -m http.server 8000)

# a real fetch (spends a few cents of credit)
APIFY_TOKEN=... STORE_DIR=store node scripts/fetch.mjs
```

`fetch.mjs` assembles everything in memory and only writes at the very end, so a failed run
always leaves the previous store byte-identical.

### Layout

| Path | Role |
|---|---|
| `sources.json` | The only file you edit routinely. |
| `scripts/fetch.mjs` | Fetch → dedupe → mirror thumbnails → score → prune → write. |
| `scripts/normalize.mjs` | Actor adapter. All raw field names live here. |
| `scripts/promo.mjs` | Promo scoring. Pure, no network. |
| `scripts/test-promo.mjs` | Tests for the two above. |
| `scripts/make-fixture.mjs` | Fake data for local UI work. |
| `index.html` / `app.js` / `style.css` | The site. No framework, no build step. |
| `.github/workflows/update.yml` | Cron, data branch, Pages deploy. |

### Branches

- `main` — site source, config, workflow.
- `data` — an **orphan branch, force-pushed to a single commit** holding `feed.json` and
  `media/`. Thumbnails are ~150KB each; committing them to `main` daily would push the repo into
  the gigabytes within a year. One-commit history means the repo size stays bounded forever with
  no maintenance. Do not merge `data` into anything.

---

## Privacy

The repo has to be public for free Pages, so the mirrored thumbnails are publicly readable by
anyone who knows the URL. Mitigations in place: `robots.txt` disallows everything, the page
sends `noindex, nofollow`, and only thumbnails are stored — never full-resolution media.

If you want it genuinely private, GitHub Pages on a private repo requires a paid plan.

## Legal

This scrapes public Instagram content, which is against Instagram's Terms of Service, though
enforcement against read-only personal use is effectively nonexistent. Keep it personal and
non-commercial. Post content and images remain the property of their creators; every card links
back to the original post.
