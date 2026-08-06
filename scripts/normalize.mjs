/**
 * Actor adapter layer.
 *
 * Every Instagram scraper on Apify returns a different shape, and they get
 * delisted or rewritten without warning. Keeping the mapping in one small file
 * means switching actors is a change to THIS FILE ONLY -- fetch.mjs never
 * touches a raw field name.
 *
 * Current actor: apidojo/instagram-scraper
 *   input:  { startUrls: [...], maxItems }
 *   output: { id, code, url, createdAt, caption, likeCount, commentCount,
 *             isPinned, isPaidPartnership, isCarousel, isVideo,
 *             owner: { username, fullName }, image: { url }, video: { url } }
 *
 * Note this actor exposes `isPaidPartnership` but NOT `isSponsored`, and
 * returns no hashtags array -- promo.mjs derives hashtags from the caption.
 * See README for drop-in alternates and their field differences.
 */

export const ACTOR_ID = 'apidojo~instagram-scraper'

/** Build the actor input for a set of configured sources. */
export function buildInput(sources, { postsPerSource }) {
  return {
    startUrls: sources.map((s) => `https://www.instagram.com/${s.handle}/`),
    // maxItems is a GLOBAL cap for this actor, not per-profile.
    maxItems: sources.length * postsPerSource,
  }
}

/**
 * Map one raw dataset item to our stable internal shape.
 * Returns null for items we cannot use (no id, or no resolvable source).
 */
export function normalizeItem(raw, sourceLookup) {
  if (!raw || !raw.id) return null

  const handle = raw.owner?.username?.toLowerCase()
  if (!handle) return null

  // Only keep posts from pages we actually asked for. Guards against an actor
  // returning tagged/suggested posts from other accounts.
  const source = sourceLookup.get(handle)
  if (!source) return null

  const createdAt = toIsoOrNull(raw.createdAt)
  if (!createdAt) return null

  return {
    id: String(raw.id),
    code: raw.code ?? null,
    url: raw.url ?? (raw.code ? `https://www.instagram.com/p/${raw.code}/` : null),
    handle,
    sourceName: source.name || raw.owner?.fullName || handle,
    createdAt,
    caption: typeof raw.caption === 'string' ? raw.caption : '',
    likeCount: numOrNull(raw.likeCount),
    commentCount: numOrNull(raw.commentCount),
    isVideo: Boolean(raw.isVideo),
    isCarousel: Boolean(raw.isCarousel),
    isPinned: Boolean(raw.isPinned),
    isPaidPartnership: Boolean(raw.isPaidPartnership ?? raw.isSponsored),
    // For video posts this actor still populates `image` with the poster frame,
    // which is exactly the thumbnail we want to mirror.
    remoteImageUrl: raw.image?.url ?? null,
    // Filled in by fetch.mjs once the thumbnail is mirrored locally.
    image: null,
    promoScore: 0,
    promoReasons: [],
  }
}

function toIsoOrNull(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
