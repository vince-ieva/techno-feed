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
 * vocabulary is matched in EN/ES/CA/IT/DE rather than English only -- a
 * Barcelona club posting "prevenda oberta" or "entrades a la venda" is exactly
 * the case this needs to catch, and Catalan is easy to miss because it looks
 * close enough to Spanish to seem covered when it is not.
 */
export const PROMO_PATTERNS = [
  // Calls to action
  { re: /\blink in (?:bio|the bio)\b/i, label: 'link in bio' },
  { re: /\bswipe up\b/i, label: 'swipe up' },
  { re: /\bcheck (?:the |our )?(?:bio|link)\b/i, label: 'check bio' },
  { re: /\bdm (?:us|me) (?:for|to)\b/i, label: 'DM to buy' },
  { re: /\b(?:link|enlace|enllaç) (?:en|a) (?:la )?(?:bio|biografia)\b/i, label: 'link en la bio (ES/CA)' },

  // Ticketing
  { re: /\btickets?\b/i, label: 'tickets' },
  // "tix" is not a cute variant to skip -- Society of Art writes every ticket
  // push as "LAST 100 tix at 19€+bfee", which scored 0 until this was added.
  { re: /\btix\b/i, label: 'tix' },
  { re: /\bb-?fee\b|\bbooking fee\b/i, label: 'booking fee' },
  { re: /\d+\s?€|€\s?\d+/, label: 'price in €' },
  { re: /\bpre-?sale[sd]?\b/i, label: 'presale' },
  { re: /\bon sale\b/i, label: 'on sale' },
  { re: /\bsold out\b/i, label: 'sold out' },
  { re: /\blast (?:call|release|tickets?|tix|spots?|\d+)\b/i, label: 'last call/release' },
  { re: /\bguest ?list\b/i, label: 'guestlist' },
  { re: /\bfree (?:entry|entrance)\b/i, label: 'free entry' },
  { re: /\bentrada (?:gratuita|lliure|gratis)\b/i, label: 'entrada gratuita (ES/CA)' },
  { re: /\bbiglietti\b/i, label: 'biglietti (IT tickets)' },
  { re: /\bprevendit[ae]\b/i, label: 'prevendita (IT presale)' },
  { re: /\bvorverkauf\b/i, label: 'Vorverkauf (DE presale)' },

  // Spanish / Catalan ticketing. All the configured pages are Barcelona
  // venues, so this block does most of the real work for this feed.
  { re: /\bentradas?\b/i, label: 'entradas (ES tickets)' },
  { re: /\bentrades\b/i, label: 'entrades (CA tickets)' },
  { re: /\bpre-?vent[ae]\b/i, label: 'preventa (ES presale)' },
  { re: /\bpre-?venda\b/i, label: 'prevenda (CA presale)' },
  { re: /\ba la vend[ae]\b/i, label: 'a la venta/venda (ES/CA on sale)' },
  { re: /\bagotad[ao]s?\b/i, label: 'agotado (ES sold out)' },
  { re: /\besgotad(?:es|s|a|es)?\b/i, label: 'esgotades (CA sold out)' },
  { re: /\b(?:últim[ae]s|ultim[ae]s) (?:entrad[ae]s|entrades|places)\b/i, label: 'últimas entradas (ES/CA)' },
  { re: /\blista\b(?=[^.]*\bnombres?\b)/i, label: 'lista de nombres (ES guestlist)' },

  // Discounts and money
  { re: /\bpromo ?code\b/i, label: 'promo code' },
  { re: /\bdiscount\b/i, label: 'discount' },
  { re: /\bcodice sconto\b/i, label: 'codice sconto (IT discount)' },
  { re: /\bsconto\b/i, label: 'sconto (IT discount)' },
  { re: /\bdescuento\b/i, label: 'descuento (ES discount)' },
  { re: /\bdescompte\b/i, label: 'descompte (CA discount)' },
  { re: /\bcódigo\b(?=[^.]*\bdescuento\b)/i, label: 'código descuento (ES)' },
  { re: /-\s?\d{1,2}\s?% ?(?:off)?\b/i, label: 'percentage off' },

  // Contests
  { re: /\bgiveaway\b/i, label: 'giveaway' },
  { re: /\bgewinnspiel\b/i, label: 'Gewinnspiel (DE giveaway)' },
  { re: /\bsorte(?:o|amos|ig|gem)\b/i, label: 'sorteo/sorteamos (ES/CA giveaway)' },
  { re: /\btag (?:a |your )?(?:friend|\d)/i, label: 'tag-a-friend' },
  { re: /\betiquet[ae] a (?:un|dos|tu)\b/i, label: 'etiqueta a un amigo (ES)' },
  { re: /\bsave this post\b|\bguarda este post\b/i, label: 'save-this-post bait' },

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

/**
 * Signals that a post is genuine news even though it mentions ticketing.
 *
 * A cancellation notice necessarily talks about tickets and refunds, and it is
 * exactly the post you most want to read -- flagging it as promo is the failure
 * that makes the chip untrustworthy. Each match subtracts from the score.
 *
 * Kept deliberately narrow: only things that are almost never a sales pitch.
 */
export const NEWS_PATTERNS = [
  { re: /\bcancel(?:l?ed|l?ation|ado|ada|ación|·lat)\b/i, label: 'cancellation' },
  { re: /\b(?:postponed|aplazad[oa]|posposa[dt]|verschoben)\b/i, label: 'postponed' },
  { re: /\bnew date\b|\bnueva fecha\b|\bnova data\b/i, label: 'rescheduled' },
  { re: /\brefund(?:s|ed)?\b|\breembolso\b|\bdevoluci[óo]n\b/i, label: 'refund' },
  { re: /\bweather conditions?\b|\bcondiciones meteorol[óo]gicas\b|\bcondicions meteorol[òo]giques\b/i, label: 'weather notice' },
  { re: /\bdue to (?:the )?weather\b|\bpor (?:el )?mal tiempo\b/i, label: 'weather notice' },
  { re: /\bin memor(?:y|iam)\b|\brest in peace\b|\bdescanse en paz\b/i, label: 'obituary' },
]

/** How much each news signal pulls the score down. */
const NEWS_PATTERN_WEIGHT = 2

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

  // News signals pull back down. Applied after the positives so a cancellation
  // notice that mentions refunds ends up unflagged rather than marked as promo.
  // A platform paid-partnership flag is factual, so it is never overridden.
  if (!(post.isPaidPartnership || post.isSponsored)) {
    for (const { re, label } of NEWS_PATTERNS) {
      if (re.test(caption)) {
        reasons.push(`news signal: ${label}`)
        score -= NEWS_PATTERN_WEIGHT
      }
    }
  }

  const clamped = Math.max(0, Math.min(score, 3))
  // If the news signals won, the promo reasons are noise -- drop them so the
  // tooltip does not claim reasons for a chip that is not being shown.
  return clamped === 0 ? { score: 0, reasons: [] } : { score: clamped, reasons }
}
