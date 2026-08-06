/**
 * Actor adapter layer.
 *
 * Every Instagram scraper on Apify returns a different shape, and they get
 * delisted, rewritten or paywalled without warning. Keeping the mapping in one
 * small file means switching actors is a change to THIS FILE ONLY -- fetch.mjs
 * never touches a raw field name.
 *
 * Current actor: apify/instagram-post-scraper
 *   input:  { username: ['handle', ...], resultsLimit, dataDetailLevel,
 *             onlyPostsNewerThan?, skipPinnedPosts? }
 *   output: { id, shortCode, url, type, timestamp, caption, displayUrl,
 *             ownerUsername, ownerFullName, likesCount, commentsCount,
 *             isPinned, hashtags[], paidPartnership? }
 *
 * Why this actor: the previously-used `apidojo/instagram-scraper` refuses API
 * access on Apify's Free plan ("The developer of this actor doesn't allow the
 * use of API in the Free Plan"), which is fatal here because the whole design
 * calls the actor by API from GitHub Actions. Apify's own actors have no such
 * restriction. Verified working on Free.
 *
 * Two field quirks that matter:
 *   - `resultsLimit` is PER PROFILE here, not a global cap.
 *   - `likesCount` is -1 when Instagram hides like counts, which is common.
 *     Treated as unavailable rather than rendered as "-1 likes".
 */

export const ACTOR_ID = 'apify~instagram-post-scraper'

/**
 * `basicData` charges only the (free) `post` event. `detailedData` additionally
 * charges `post-details` at ~$0.0027/post and is the ONLY way to get the
 * `paidPartnership` flag.
 *
 * Default is basic: these are club/promoter pages, which effectively never use
 * Instagram's formal paid-partnership label (it is an influencer feature), so
 * the flag buys almost nothing here while roughly tripling the monthly cost.
 * Promo detection leans on caption keywords instead -- see promo.mjs.
 */
export const DEFAULT_DETAIL_LEVEL = 'basicData'

/** How far back to look before the newest stored post, as a safety margin. */
const WATERMARK_BUFFER_DAYS = 2

/**
 * Build the actor input.
 *
 * @param {Array<{handle: string}>} sources
 * @param {object} opts
 * @param {number} opts.postsPerSource   per-profile cap
 * @param {string} [opts.dataDetailLevel]
 * @param {string|null} [opts.onlyPostsNewerThan] ISO date, or null for a full fetch
 */
export function buildInput(sources, { postsPerSource, dataDetailLevel, onlyPostsNewerThan }) {
  const input = {
    username: sources.map((s) => s.handle),
    resultsLimit: postsPerSource,
    dataDetailLevel: dataDetailLevel ?? DEFAULT_DETAIL_LEVEL,
  }
  // Cost here is per post RETURNED, not per new post -- without this, every run
  // re-fetches and re-charges for the same backlog. Omitted on a cold start.
  if (onlyPostsNewerThan) input.onlyPostsNewerThan = onlyPostsNewerThan
  return input
}

/**
 * Decide the incremental watermark from what is already stored.
 *
 * Returns null (meaning: fetch everything) unless EVERY configured source
 * already has stored posts. Otherwise a newly-added page would silently inherit
 * the other pages' watermark and lose its history.
 *
 * @param {Array<{handle: string}>} sources
 * @param {Array<{handle: string, createdAt: string}>} existingPosts
 * @returns {string|null} ISO timestamp
 */
export function computeWatermark(sources, existingPosts) {
  if (!sources.length || !existingPosts?.length) return null

  const newestByHandle = new Map()
  for (const post of existingPosts) {
    const t = new Date(post.createdAt).getTime()
    if (Number.isNaN(t)) continue
    if (!newestByHandle.has(post.handle) || t > newestByHandle.get(post.handle)) {
      newestByHandle.set(post.handle, t)
    }
  }

  const watermarks = []
  for (const source of sources) {
    const handle = source.handle.toLowerCase()
    if (!newestByHandle.has(handle)) return null // cold source -> full fetch
    watermarks.push(newestByHandle.get(handle))
  }

  // The oldest per-source watermark, so no source is skipped, minus a buffer.
  const oldest = Math.min(...watermarks)
  return new Date(oldest - WATERMARK_BUFFER_DAYS * 86_400_000).toISOString()
}

/**
 * Map one raw dataset item to our stable internal shape.
 * Returns null for items we cannot use.
 */
export function normalizeItem(raw, sourceLookup) {
  if (!raw || !raw.id) return null

  const attribution = attribute(raw, sourceLookup)
  if (!attribution) return null
  const { handle, source, viaCoauthor } = attribution

  const createdAt = toIsoOrNull(raw.timestamp)
  if (!createdAt) return null

  return {
    id: String(raw.id),
    code: raw.shortCode ?? null,
    url: raw.url ?? (raw.shortCode ? `https://www.instagram.com/p/${raw.shortCode}/` : null),
    handle,
    sourceName: source.name || raw.ownerFullName || handle,
    // Co-authored posts appear on the configured club's grid but are "owned" by
    // the other account, so record who actually posted it.
    coauthorOf: viaCoauthor ? (raw.ownerUsername?.toLowerCase() ?? null) : null,
    createdAt,
    caption: typeof raw.caption === 'string' ? raw.caption : '',
    likeCount: countOrNull(raw.likesCount),
    commentCount: countOrNull(raw.commentsCount),
    isVideo: raw.type === 'Video',
    isCarousel: raw.type === 'Sidecar',
    isPinned: Boolean(raw.isPinned),
    // Only present on dataDetailLevel: 'detailedData'.
    isPaidPartnership: Boolean(raw.paidPartnership),
    remoteImageUrl: raw.displayUrl ?? null,
    // Filled in by fetch.mjs once the thumbnail is mirrored locally.
    image: null,
    promoScore: 0,
    promoReasons: [],
  }
}

/**
 * Work out which configured source a post belongs to.
 *
 * Instagram co-authored posts appear on every co-author's grid, but the actor
 * reports a single `ownerUsername` -- often another venue. Matching on owner
 * alone silently discarded ~29% of a real run (12 of 42 posts), including a
 * Prism x Input giveaway that appeared on Input's own profile.
 *
 * `basicData` includes `coauthorProducers`, so fall back to the first co-author
 * that IS configured. `inputUrl` would be the direct answer but only exists on
 * the pricier `detailedData` level.
 *
 * @returns {{handle: string, source: object, viaCoauthor: boolean}|null}
 */
function attribute(raw, sourceLookup) {
  const owner = raw.ownerUsername?.toLowerCase()
  if (owner) {
    const source = sourceLookup.get(owner)
    if (source) return { handle: owner, source, viaCoauthor: false }
  }

  for (const co of raw.coauthorProducers ?? []) {
    const handle = String(co?.username ?? '').toLowerCase()
    const source = sourceLookup.get(handle)
    if (source) return { handle, source, viaCoauthor: true }
  }

  return null // Not from any page we asked for.
}

function toIsoOrNull(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Instagram returns -1 for counts it hides (like counts are frequently hidden).
 * Treat anything negative as unavailable so the UI omits it instead of
 * rendering "-1 likes".
 */
function countOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}
