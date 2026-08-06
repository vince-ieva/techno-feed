#!/usr/bin/env node
/**
 * Fetch new posts -> dedupe -> mirror thumbnails -> score -> prune -> write.
 *
 * Design rule: the store on disk is NEVER partially written. Everything is
 * assembled in memory and only committed at the very end, so a network failure
 * or an exhausted Apify balance leaves the previous good store untouched and
 * the site keeps serving it behind a staleness banner.
 *
 * Usage:  APIFY_TOKEN=... node scripts/fetch.mjs
 * Env:
 *   APIFY_TOKEN  required
 *   STORE_DIR    output dir (default ./store)
 *   CONFIG       config path (default ./sources.json)
 */

import { readFile, writeFile, mkdir, readdir, rm, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ACTOR_ID, buildInput, normalizeItem, computeWatermark } from './normalize.mjs'
import { scorePost } from './promo.mjs'

const APIFY_TOKEN = process.env.APIFY_TOKEN
const STORE_DIR = resolve(process.env.STORE_DIR ?? 'store')
const CONFIG_PATH = resolve(process.env.CONFIG ?? 'sources.json')
const MEDIA_DIR = join(STORE_DIR, 'media')
const FEED_PATH = join(STORE_DIR, 'feed.json')

const API = 'https://api.apify.com/v2'
const POLL_INTERVAL_MS = 5_000
const RUN_TIMEOUT_MS = 8 * 60_000
const IMAGE_TIMEOUT_MS = 30_000
// A plain browser UA. The Instagram CDN serves thumbnails without auth but is
// unfriendly to obviously-scripted clients.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

const log = (...a) => console.log('[fetch]', ...a)

async function main() {
  if (!APIFY_TOKEN) fail('APIFY_TOKEN is not set. Get one free at apify.com -> Settings -> API & Integrations.')

  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  const sources = (config.sources ?? []).filter((s) => s?.handle)
  if (!sources.length) fail(`No sources configured in ${CONFIG_PATH}.`)

  const postsPerSource = config.postsPerSource ?? 6
  const maxStoredPosts = config.maxStoredPosts ?? 300

  const sourceLookup = new Map(sources.map((s) => [s.handle.toLowerCase(), s]))
  log(`${sources.length} sources, ${postsPerSource} posts each`)

  const existing = await loadExistingFeed()
  log(`existing store: ${existing.posts.length} posts`)

  // Billing is per post RETURNED, so without a watermark every run pays for the
  // whole backlog again. Null on a cold start or when a source is new.
  const watermark = computeWatermark(sources, existing.posts)
  log(watermark ? `incremental: only posts newer than ${watermark}` : 'full fetch (no watermark yet)')

  // --- Network phase. Any throw here aborts before we touch the store. ---
  const input = buildInput(sources, {
    postsPerSource,
    dataDetailLevel: config.dataDetailLevel,
    onlyPostsNewerThan: watermark,
  })
  const { items: rawItems, statusMessage } = await runActor(input)
  log(`actor returned ${rawItems.length} raw items`)

  const fetched = rawItems.map((r) => normalizeItem(r, sourceLookup)).filter(Boolean)
  log(`${fetched.length} usable after normalization`)

  // An empty result is ambiguous: genuinely nothing new (fine, on an
  // incremental run) versus the actor refusing to work (not fine). Distinguish
  // them, and surface the actor's own status message either way -- guessing
  // wrong here once cost a lot of debugging.
  if (!fetched.length) {
    const detail = statusMessage ? ` Actor said: "${statusMessage}"` : ''
    // `noResults` markers are how some actors report "found nothing at all".
    const sawNoResultsMarker = rawItems.some((r) => r?.noResults)

    if (watermark && !rawItems.length) {
      log(`no new posts since the watermark -- nothing to do.${detail}`)
      return // Not an error: this is the steady state on a quiet day.
    }
    fail(
      `Actor returned no usable posts. Store left unchanged.${detail}` +
        (sawNoResultsMarker
          ? '\n  The actor reported noResults for every input. Check the handles in' +
            ' sources.json, and whether this actor permits API access on your Apify plan.'
          : ''),
    )
  }

  // --- Merge. Existing posts win, so already-mirrored images are not refetched. ---
  const byId = new Map(existing.posts.map((p) => [p.id, p]))
  const newPosts = []
  for (const post of fetched) {
    if (byId.has(post.id)) continue
    byId.set(post.id, post)
    newPosts.push(post)
  }
  log(`${newPosts.length} new posts`)

  // Re-score everything, so tweaking promo.mjs updates the whole backlog on the
  // next run rather than only applying to new posts.
  for (const post of byId.values()) {
    const { score, reasons } = scorePost(post)
    post.promoScore = score
    post.promoReasons = reasons
  }

  const posts = [...byId.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, maxStoredPosts)

  // --- Mirror thumbnails for new posts that survived the cap. ---
  // Instagram CDN URLs are signed and expire (403 "URL signature expired"), so
  // the image must live in the repo or the site rots into broken thumbnails.
  await mkdir(MEDIA_DIR, { recursive: true })
  const kept = new Set(posts.map((p) => p.id))
  const toMirror = posts.filter((p) => !p.image && p.remoteImageUrl)
  let mirrored = 0
  for (const post of toMirror) {
    const filename = `${post.id}.jpg`
    if (await downloadImage(post.remoteImageUrl, join(MEDIA_DIR, filename))) {
      post.image = `media/${filename}`
      mirrored++
    }
    // On failure image stays null and the site renders a text-only card.
  }
  log(`mirrored ${mirrored}/${toMirror.length} thumbnails`)

  // The signed URL is dead within days -- storing it would only mislead.
  for (const post of posts) delete post.remoteImageUrl

  await pruneMedia(kept)

  const feed = {
    generatedAt: new Date().toISOString(),
    sources: sources.map(({ handle, name }) => ({ handle: handle.toLowerCase(), name })),
    counts: { total: posts.length, new: newPosts.length, promo: posts.filter((p) => p.promoScore > 0).length },
    posts,
  }

  await writeJsonAtomic(FEED_PATH, feed)
  log(`wrote ${posts.length} posts -> ${FEED_PATH}`)
}

async function loadExistingFeed() {
  try {
    const parsed = JSON.parse(await readFile(FEED_PATH, 'utf8'))
    return { posts: Array.isArray(parsed.posts) ? parsed.posts : [] }
  } catch {
    return { posts: [] } // First run, or a corrupt store we can safely rebuild.
  }
}

/**
 * Start the actor, poll until it settles, return its dataset items plus the
 * actor's final status message (which is where actors explain refusals).
 */
async function runActor(input) {
  const start = await apify(`${API}/acts/${ACTOR_ID}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  const runId = start?.data?.id
  const datasetId = start?.data?.defaultDatasetId
  if (!runId || !datasetId) throw new Error(`Unexpected run response: ${JSON.stringify(start).slice(0, 300)}`)
  log(`run ${runId} started`)

  const deadline = Date.now() + RUN_TIMEOUT_MS
  let status = start.data.status
  let run = start.data
  while (status === 'READY' || status === 'RUNNING') {
    if (Date.now() > deadline) throw new Error(`Run ${runId} still ${status} after ${RUN_TIMEOUT_MS / 1000}s.`)
    await sleep(POLL_INTERVAL_MS)
    run = (await apify(`${API}/actor-runs/${runId}`))?.data ?? run
    status = run.status
    log(`  status: ${status}`)
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(
      `Run ${runId} finished as ${status}. ${run.statusMessage ?? ''}` +
        ` Check https://console.apify.com/actors/runs/${runId}`,
    )
  }

  if (run.usageTotalUsd != null) log(`run cost: $${run.usageTotalUsd.toFixed(4)}`)
  if (run.chargedEventCounts) log(`charged events: ${JSON.stringify(run.chargedEventCounts)}`)

  const items = await apify(`${API}/datasets/${datasetId}/items?clean=true&format=json`)
  return { items: Array.isArray(items) ? items : [], statusMessage: run.statusMessage ?? null }
}

async function apify(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${APIFY_TOKEN}`, ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // 402 is the one worth calling out: it means the free monthly credits ran
    // out, which is a budget problem rather than a bug.
    const hint = res.status === 402 ? ' -- monthly Apify credits appear to be exhausted.' : ''
    throw new Error(`Apify ${res.status} ${res.statusText}${hint} ${body.slice(0, 300)}`)
  }
  return res.json()
}

async function downloadImage(url, destPath) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/jpeg,*/*' },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength < 1024) throw new Error(`suspiciously small (${buf.byteLength}B)`)
    await writeFile(destPath, buf)
    return true
  } catch (err) {
    log(`  ! thumbnail failed: ${err.message}`)
    return false
  }
}

/** Delete media whose post fell out of the rolling window. */
async function pruneMedia(keptIds) {
  let removed = 0
  let files
  try {
    files = await readdir(MEDIA_DIR)
  } catch {
    return
  }
  for (const file of files) {
    if (!keptIds.has(file.replace(/\.jpg$/, ''))) {
      await rm(join(MEDIA_DIR, file), { force: true })
      removed++
    }
  }
  if (removed) log(`pruned ${removed} orphaned media files`)
}

/** Write via temp file + rename so a crash mid-write cannot truncate the feed. */
async function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2))
  await rename(tmp, path)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(message) {
  console.error(`[fetch] ERROR: ${message}`)
  process.exit(1)
}

main().catch((err) => fail(err.message))
