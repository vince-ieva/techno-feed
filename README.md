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

Measured, not estimated — from real runs against the 7 configured clubs:

| | Charged events | Cost |
|---|---|---|
| Cold run, 7 sources × 6 posts (42 posts) | `post: 42`, `post-details: 0` | **$0.061** |
| Same with `detailedData` | `post: 42`, `post-details: 42` | $0.174 |

At `basicData` and one run per day that is **~$1.84/month** worst case, against **$5/month** of
free credits. In practice much less, because `onlyPostsNewerThan` means a normal day fetches only
the handful of genuinely new posts rather than the whole backlog.

Two settings drive this:

- **`dataDetailLevel`** (default `basicData`). `detailedData` roughly triples the cost and its
  only real benefit here is the `paidPartnership` flag — which club and promoter pages
  essentially never set, since it is an influencer/brand-deal feature. Set
  `"dataDetailLevel": "detailedData"` in `sources.json` if you ever want it.
- **Cadence.** Billing is per post *returned*, not per *new* post, so without the incremental
  watermark every run would pay for the full backlog again.

Credits do not roll over, and Apify blocks runs once they are spent — at which point the site
keeps serving the last good data behind a staleness banner. To change cadence, edit the `cron`
line in [`.github/workflows/update.yml`](.github/workflows/update.yml).

---

## Promo marking

Posts are scored 0–3 in [`scripts/promo.mjs`](scripts/promo.mjs) and shown with a `PROMO` chip —
**hover it to see exactly why it was flagged**. Nothing is hidden unless you tick "Hide promo".

| Score | Trigger |
|---|---|
| 3 | Instagram's own paid-partnership flag, or several weaker signals stacked |
| 1–2 | Caption keywords: tickets, `tix`, presale, prices in €, booking fee, link in bio, giveaway, discount, `#ad`, … |
| +1 | More than 12 hashtags |
| **−2 each** | `NEWS_PATTERNS`: cancellation, postponement, refund, weather notice, obituary |

Keywords are matched in English, **Spanish, Catalan**, Italian and German. The Spanish/Catalan
set does most of the work for this feed — `entrades a la venda` and `prevenda oberta` get caught,
not just `presale`.

`NEWS_PATTERNS` exists because a cancellation notice necessarily talks about tickets and refunds,
and it is exactly the post you most want to read. A real Onírica weather-cancellation post was
being marked as promo until these were added. A platform paid-partnership flag is factual and is
never talked down by them.

### Tuning against real captions

Scoring is pure and offline, so iterate for free — no actor call, no credits:

```bash
node scripts/rescore.mjs --audit   # every stored post with its score and reasons
# edit PROMO_PATTERNS / NEWS_PATTERNS in scripts/promo.mjs
node scripts/rescore.mjs --dry     # what would change, writes nothing
node scripts/test-promo.mjs        # keep the regressions green
node scripts/rescore.mjs           # apply to the stored feed
```

Two real misses this loop caught, both now regression-tested: Society of Art writes every ticket
push as `LAST 100 tix at 19€+bfee` — which scored **0** until `tix`, `bfee` and euro prices were
added — and the weather cancellation above.

The whole backlog is re-scored on every fetch too, so changes apply retroactively.

---

## If it breaks

**The most likely failure is the actor changing, being delisted, or paywalling the API.** All
actor-specific field mapping lives in [`scripts/normalize.mjs`](scripts/normalize.mjs) — nothing
else touches a raw field name, so swapping is a one-file change.

Current actor: **`apify~instagram-post-scraper`** (input `username[]`, `resultsLimit`,
`dataDetailLevel`, `onlyPostsNewerThan`; output `id`, `shortCode`, `url`, `type`, `timestamp`,
`caption`, `displayUrl`, `ownerUsername`, `likesCount`, `coauthorProducers`).

> **Do not switch to `apidojo~instagram-scraper`.** It was the original choice and it refuses API
> access on the Free plan — *"The developer of this actor doesn't allow the use of API in the Free
> Plan"* — which is fatal here, because GitHub Actions can only reach it by API. The run reports
> `SUCCEEDED` and quietly returns `{"noResults": true}` for every input, so the failure is easy
> to misread as a bug in this repo. Prefer Apify's own (`apify~…`) actors, which have no such
> restriction.

Drop-in alternates, and how they differ:

| Actor | Differences to handle in `normalize.mjs` |
|---|---|
| `apify~instagram-scraper` | The general-purpose one. Input uses `directUrls` + `resultsType: 'posts'`. Output is close to the current actor's. |
| `netdesignr~instagram-posts-scraper-pro` | Output uses `publishedAt`, `media[]`, and exposes **both** `isSponsored` and `isPaidPartnership`. Verify free-plan API access first. |

### Two field quirks worth knowing

- **`likesCount` is `-1`** when Instagram hides like counts (18 of 42 posts in a real run).
  `normalize.mjs` maps negatives to `null` so the UI omits the count instead of showing
  "-1 likes".
- **Collab posts report another account as owner.** Instagram co-authored posts appear on a
  configured club's grid but carry a different `ownerUsername`. Matching on owner alone silently
  discarded **12 of 42 posts** in a real run. `normalize.mjs` falls back to `coauthorProducers`
  and records the real poster in `coauthorOf`.

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
node scripts/rescore.mjs --audit     # re-score the real store, free

# preview exactly what gets deployed
mkdir -p _site && cp index.html app.js style.css icon.svg manifest.webmanifest robots.txt _site/
cp -r store/. _site/ && python3 -m http.server 8000 --directory _site

# a real fetch (~6 cents for a cold run over 7 sources)
echo 'APIFY_TOKEN=apify_api_...' > .env.local     # gitignored
set -a && . ./.env.local && set +a
STORE_DIR=store node scripts/fetch.mjs
```

A local HTTP server is required — opening `index.html` over `file://` fails, because `app.js`
fetches `feed.json` and browsers block that on the `file:` origin.

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
| `scripts/rescore.mjs` | Re-score the stored feed offline, for tuning keywords for free. |
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
