/**
 * Promo scoring.
 *
 * The goal is NOT to hide anything -- it is to attach an explainable score so
 * the site can show a chip you can hover to see *why* a post looked like promo.
 * Filtering is a client-side choice, off by default.
 *
 * Score is 0-3:
 *   3  the platform itself flagged it (paid partnership / sponsored)
 *   1-2 caption heuristics fired
 *   0  looks like ordinary content
 *
 * No network, no dependencies -- so this is directly unit-testable.
 */

/**
 * Caption patterns that suggest the post is selling something.
 *
 * Techno pages are overwhelmingly European, so the ticket/presale/giveaway
 * vocabulary is matched in EN/IT/DE/ES rather than English only -- an Italian
 * club posting "prevendite aperte" is exactly the case this needs to catch.
 */
export const PROMO_PATTERNS = [
  // Calls to action
  { re: /\blink in (?:bio|the bio)\b/i, label: 'link in bio' },
  { re: /\bswipe up\b/i, label: 'swipe up' },
  { re: /\bcheck (?:the |our )?(?:bio|link)\b/i, label: 'check bio' },
  { re: /\bdm (?:us|me) (?:for|to)\b/i, label: 'DM to buy' },

  // Ticketing
  { re: /\btickets?\b/i, label: 'tickets' },
  { re: /\bpre-?sale[sd]?\b/i, label: 'presale' },
  { re: /\bon sale\b/i, label: 'on sale' },
  { re: /\bsold out\b/i, label: 'sold out' },
  { re: /\blast (?:release|tickets?|spots?)\b/i, label: 'last release' },
  { re: /\bguest ?list\b/i, label: 'guestlist' },
  { re: /\bbiglietti\b/i, label: 'biglietti (IT tickets)' },
  { re: /\bprevendit[ae]\b/i, label: 'prevendita (IT presale)' },
  { re: /\bvorverkauf\b/i, label: 'Vorverkauf (DE presale)' },
  { re: /\bentradas\b/i, label: 'entradas (ES tickets)' },

  // Discounts and money
  { re: /\bpromo ?code\b/i, label: 'promo code' },
  { re: /\bdiscount\b/i, label: 'discount' },
  { re: /\bcodice sconto\b/i, label: 'codice sconto (IT discount)' },
  { re: /\bsconto\b/i, label: 'sconto (IT discount)' },
  { re: /-\s?\d{1,2}\s?% ?(?:off)?\b/i, label: 'percentage off' },

  // Contests
  { re: /\bgiveaway\b/i, label: 'giveaway' },
  { re: /\bgewinnspiel\b/i, label: 'Gewinnspiel (DE giveaway)' },
  { re: /\bsorteo\b/i, label: 'sorteo (ES giveaway)' },
  { re: /\btag (?:a |your )?(?:friend|\d)/i, label: 'tag-a-friend' },

  // Explicit ad disclosure
  { re: /(?:^|\s)#(?:ad|adv|advert|sponsored|werbung|pubblicita)\b/i, label: '#ad hashtag' },
  { re: /\bsponsored\b/i, label: 'sponsored' },
  { re: /\bpresented by\b/i, label: 'presented by' },
  { re: /\bin (?:partnership|collaboration) with\b/i, label: 'partnership' },
  { re: /\bpaid partnership\b/i, label: 'paid partnership' },

  // Merch
  { re: /\b(?:shop|store) now\b/i, label: 'shop now' },
  { re: /\bout now on (?:vinyl|bandcamp)\b/i, label: 'merch/vinyl push' },
]

/** Hashtag stuffing is a weak promo signal on its own. */
export const HASHTAG_STUFFING_THRESHOLD = 12

/** Extract hashtags from a caption. This actor does not return them separately. */
export function extractHashtags(caption) {
  if (!caption) return []
  // Unicode-aware: techno captions routinely use non-ASCII tags (#präzision).
  return caption.match(/#[\p{L}\p{N}_]+/gu) ?? []
}

/**
 * Score a post for promo signals.
 *
 * @param {object} post
 * @param {string} [post.caption]
 * @param {boolean} [post.isPaidPartnership] from the actor, when available
 * @param {boolean} [post.isSponsored] some actors expose this instead
 * @returns {{score: number, reasons: string[]}} score clamped to 0-3
 */
export function scorePost(post = {}) {
  const reasons = []
  let score = 0

  // A platform-level flag is authoritative -- go straight to the top.
  if (post.isPaidPartnership || post.isSponsored) {
    reasons.push('flagged by Instagram as a paid partnership')
    score = 3
  }

  const caption = post.caption ?? ''

  for (const { re, label } of PROMO_PATTERNS) {
    if (re.test(caption)) {
      reasons.push(label)
      score += 1
    }
  }

  const hashtags = extractHashtags(caption)
  if (hashtags.length > HASHTAG_STUFFING_THRESHOLD) {
    reasons.push(`${hashtags.length} hashtags`)
    score += 1
  }

  return { score: Math.min(score, 3), reasons }
}
