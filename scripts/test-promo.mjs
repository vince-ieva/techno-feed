#!/usr/bin/env node
/**
 * Offline tests for the promo scorer and the actor adapter.
 * No network, no APIFY_TOKEN needed:  node scripts/test-promo.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { scorePost, extractHashtags, HASHTAG_STUFFING_THRESHOLD } from './promo.mjs'
import { normalizeItem, buildInput, computeWatermark } from './normalize.mjs'

test('platform paid-partnership flag scores maximum', () => {
  const { score, reasons } = scorePost({ caption: 'new mix out now', isPaidPartnership: true })
  assert.equal(score, 3)
  assert.match(reasons[0], /paid partnership/)
})

test('some actors use isSponsored instead of isPaidPartnership', () => {
  assert.equal(scorePost({ caption: 'hello', isSponsored: true }).score, 3)
})

test('ticket-sale captions are flagged', () => {
  const { score, reasons } = scorePost({
    caption: 'Final release tickets on sale now — link in bio!',
  })
  assert.ok(score > 0)
  assert.ok(reasons.includes('tickets'))
  assert.ok(reasons.includes('on sale'))
  assert.ok(reasons.includes('link in bio'))
})

test('Italian presale vocabulary is flagged', () => {
  const { score, reasons } = scorePost({ caption: 'Prevendite aperte! Biglietti disponibili ora' })
  assert.ok(score > 0)
  assert.ok(reasons.some((r) => /prevendita/i.test(r)))
  assert.ok(reasons.some((r) => /biglietti/i.test(r)))
})

test('German presale and giveaway vocabulary is flagged', () => {
  assert.ok(scorePost({ caption: 'Vorverkauf startet Freitag' }).score > 0)
  assert.ok(scorePost({ caption: 'Gewinnspiel: 2x2 Tickets' }).score > 0)
})

// Every configured page is a Barcelona venue, so these two languages carry
// most of the load for this feed. Catalan is the easy one to get wrong.
test('Spanish promo vocabulary is flagged', () => {
  const cases = [
    'Entradas a la venta este viernes',
    'Preventa abierta ahora',
    '¡AGOTADO! Gracias a todos',
    'Últimas entradas disponibles',
    'Sorteo: 2 entradas para el sábado',
    'Código de descuento TECHNO20',
    'Etiqueta a un amigo para participar',
    'Enlace en la bio',
  ]
  for (const caption of cases) {
    assert.ok(scorePost({ caption }).score > 0, `expected > 0 for "${caption}"`)
  }
})

test('Catalan promo vocabulary is flagged', () => {
  const cases = [
    'Entrades a la venda a partir de dijous',
    'Prevenda oberta',
    'Entrades esgotades!',
    'Sorteig de dues entrades',
    'Descompte del 20% amb el codi',
    'Enllaç a la bio',
  ]
  for (const caption of cases) {
    assert.ok(scorePost({ caption }).score > 0, `expected > 0 for "${caption}"`)
  }
})

test('Spanish and Catalan news captions are NOT flagged', () => {
  // Guards against the new patterns being so loose that ordinary announcements
  // get marked as promo -- the failure mode that would make the chip useless.
  const news = [
    'Este sábado cerramos la temporada con tres salas abiertas.',
    'Aquest dissabte tanquem la temporada amb tres sales obertes.',
    'Entrevista: diez años de música electrónica en Barcelona.',
    'Nuevo sistema de sonido instalado en la sala principal.',
    'Gràcies a tothom per una nit inoblidable.',
    'Comunicado: cambio de horario para el próximo evento.',
  ]
  for (const caption of news) {
    const { score, reasons } = scorePost({ caption })
    assert.equal(score, 0, `expected 0 for "${caption}" but got ${score} (${reasons.join(', ')})`)
  }
})

test('genuine news captions score zero', () => {
  const news = [
    'Announcing our winter programme. Full lineup below.',
    'Interview: the producer on ten years of hardware jams.',
    'RIP to a founding figure of the Detroit scene.',
    'Closing set recorded live last Saturday. Recording up on our channel.',
  ]
  for (const caption of news) {
    const { score, reasons } = scorePost({ caption })
    assert.equal(score, 0, `expected 0 for "${caption}" but got ${score} (${reasons.join(', ')})`)
  }
})

// Regression tests from auditing a real run of the 7 configured clubs.
test('"tix" and booking-fee ticket pushes are flagged', () => {
  // This exact caption scored 0 before "tix" was added -- the single worst miss
  // found in the first real run.
  const { score, reasons } = scorePost({
    caption: '🚨LAST CALL‼️ 🎟️LAST 100 tix at 19€+bfee!🚨 La única noche del año',
  })
  assert.equal(score, 3)
  assert.ok(reasons.includes('tix'))
  assert.ok(reasons.includes('booking fee'))
  assert.ok(reasons.includes('price in €'))
})

test('prices in euros are a promo signal', () => {
  assert.ok(scorePost({ caption: 'LAST 25 TICKETS AT 15€ + BFEE!' }).score > 0)
  assert.ok(scorePost({ caption: 'Entrada 20 €' }).score > 0)
})

test('cancellation and weather notices are NOT flagged as promo', () => {
  // The real Onírica post below scored 1 (via "tickets") before NEWS_PATTERNS.
  // Marking a cancellation as an ad is the failure that makes the chip useless.
  const cases = [
    'Official Announcement 📣 Due to weather conditions forecast for this Saturday, the event is cancelled. Tickets will be refunded.',
    'Evento aplazado por condiciones meteorológicas. Reembolso de entradas disponible.',
    'CANCELLED — new date to be announced. All tickets remain valid.',
  ]
  for (const caption of cases) {
    const { score } = scorePost({ caption })
    assert.equal(score, 0, `expected 0 for "${caption.slice(0, 40)}…" but got ${score}`)
  }
})

test('news signals clear the promo reasons rather than leaving a stale tooltip', () => {
  const { score, reasons } = scorePost({ caption: 'Cancelled due to weather conditions. Tickets refunded.' })
  assert.equal(score, 0)
  assert.deepEqual(reasons, [])
})

test('a platform paid-partnership flag is never overridden by news signals', () => {
  // The flag is factual; keyword heuristics must not talk it down.
  const { score } = scorePost({
    caption: 'Event cancelled due to weather conditions, tickets refunded',
    isPaidPartnership: true,
  })
  assert.equal(score, 3)
})

test('score is clamped to 3 even when many patterns fire', () => {
  const { score } = scorePost({
    caption: 'tickets presale on sale discount promo code giveaway link in bio swipe up sponsored',
  })
  assert.equal(score, 3)
})

test('empty and missing captions are safe', () => {
  assert.deepEqual(scorePost({}), { score: 0, reasons: [] })
  assert.deepEqual(scorePost({ caption: null }), { score: 0, reasons: [] })
  assert.deepEqual(scorePost(), { score: 0, reasons: [] })
})

test('hashtag extraction handles non-ASCII tags', () => {
  assert.deepEqual(extractHashtags('warehouse #präzision #テクノ #techno_1'), [
    '#präzision',
    '#テクノ',
    '#techno_1',
  ])
  assert.deepEqual(extractHashtags(''), [])
})

test('hashtag stuffing only fires above the threshold', () => {
  const atThreshold = Array.from({ length: HASHTAG_STUFFING_THRESHOLD }, (_, i) => `#t${i}`).join(' ')
  const overThreshold = `${atThreshold} #onemore`
  assert.equal(scorePost({ caption: atThreshold }).score, 0)
  assert.ok(scorePost({ caption: overThreshold }).score > 0)
})

// --- adapter ---

const LOOKUP = new Map([['nitsa_club', { handle: 'nitsa_club', name: 'Nitsa' }]])

// Copied from a real apify/instagram-post-scraper response, so the test breaks
// if the actor's shape drifts.
const RAW = {
  id: '3955531788203488538',
  shortCode: 'Dbk3zQ9onUa',
  url: 'https://www.instagram.com/p/Dbk3zQ9onUa/',
  type: 'Image',
  timestamp: '2026-08-03T11:36:35.000Z',
  caption: 'Full throttle into August this weekend',
  displayUrl: 'https://scontent-ham3-1.cdninstagram.com/v/t51.82787-15/760341871.jpg',
  ownerUsername: 'nitsa_club',
  ownerFullName: 'Nitsa Club',
  likesCount: 114,
  commentsCount: 6,
  isPinned: true,
}

test('normalizeItem maps the actor shape to our internal shape', () => {
  const post = normalizeItem(RAW, LOOKUP)
  assert.equal(post.id, '3955531788203488538')
  assert.equal(post.code, 'Dbk3zQ9onUa')
  assert.equal(post.handle, 'nitsa_club')
  assert.equal(post.sourceName, 'Nitsa') // config name wins over ownerFullName
  assert.equal(post.createdAt, '2026-08-03T11:36:35.000Z')
  assert.equal(post.remoteImageUrl, RAW.displayUrl)
  assert.equal(post.image, null)
  assert.equal(post.likeCount, 114)
  assert.equal(post.isPinned, true)
})

test('post type maps to isVideo / isCarousel', () => {
  assert.equal(normalizeItem({ ...RAW, type: 'Image' }, LOOKUP).isVideo, false)
  assert.equal(normalizeItem({ ...RAW, type: 'Video' }, LOOKUP).isVideo, true)
  assert.equal(normalizeItem({ ...RAW, type: 'Sidecar' }, LOOKUP).isCarousel, true)
  assert.equal(normalizeItem({ ...RAW, type: 'Image' }, LOOKUP).isCarousel, false)
})

test('hidden like counts (-1) become null, not "-1 likes"', () => {
  // Instagram frequently hides like counts; the real Nitsa post returned -1.
  const post = normalizeItem({ ...RAW, likesCount: -1, commentsCount: -1 }, LOOKUP)
  assert.equal(post.likeCount, null)
  assert.equal(post.commentCount, null)
  // Zero is a real value and must survive.
  assert.equal(normalizeItem({ ...RAW, likesCount: 0 }, LOOKUP).likeCount, 0)
})

test('paidPartnership is only present on detailedData, and defaults to false', () => {
  assert.equal(normalizeItem(RAW, LOOKUP).isPaidPartnership, false)
  assert.equal(normalizeItem({ ...RAW, paidPartnership: true }, LOOKUP).isPaidPartnership, true)
})

test('normalizeItem drops posts from accounts we did not request', () => {
  assert.equal(normalizeItem({ ...RAW, ownerUsername: 'someoneelse' }, LOOKUP), null)
})

// Instagram collab posts appear on a configured club's grid but report another
// account as owner. Matching on owner alone dropped 12 of 42 posts in a real run.
test('collab posts are attributed to the configured co-author', () => {
  const collab = {
    ...RAW,
    ownerUsername: 'prismbcn',
    ownerFullName: 'Prism BCN',
    coauthorProducers: [{ username: 'nitsa_club', id: '1' }],
  }
  const post = normalizeItem(collab, LOOKUP)
  assert.ok(post, 'collab post should be kept, not dropped')
  assert.equal(post.handle, 'nitsa_club') // filed under the club we follow
  assert.equal(post.sourceName, 'Nitsa')
  assert.equal(post.coauthorOf, 'prismbcn') // but we remember who posted it
})

test('owner attribution wins over co-author, and is not marked as a collab', () => {
  const post = normalizeItem({ ...RAW, coauthorProducers: [{ username: 'someoneelse' }] }, LOOKUP)
  assert.equal(post.handle, 'nitsa_club')
  assert.equal(post.coauthorOf, null)
})

test('collab posts with no configured co-author are still dropped', () => {
  const foreign = {
    ...RAW,
    ownerUsername: 'prismbcn',
    coauthorProducers: [{ username: 'luzdegasbcn' }, { username: 'deerjade' }],
  }
  assert.equal(normalizeItem(foreign, LOOKUP), null)
})

test('co-author matching tolerates odd shapes and casing', () => {
  const base = { ...RAW, ownerUsername: 'prismbcn' }
  assert.equal(normalizeItem({ ...base, coauthorProducers: [] }, LOOKUP), null)
  assert.equal(normalizeItem({ ...base, coauthorProducers: undefined }, LOOKUP), null)
  assert.equal(normalizeItem({ ...base, coauthorProducers: [null, {}] }, LOOKUP), null)
  assert.equal(
    normalizeItem({ ...base, coauthorProducers: [{ username: 'Nitsa_Club' }] }, LOOKUP)?.handle,
    'nitsa_club',
  )
})

test('normalizeItem drops items missing id, owner or a valid date', () => {
  assert.equal(normalizeItem({ ...RAW, id: undefined }, LOOKUP), null)
  assert.equal(normalizeItem({ ...RAW, ownerUsername: undefined }, LOOKUP), null)
  assert.equal(normalizeItem({ ...RAW, timestamp: 'not-a-date' }, LOOKUP), null)
  assert.equal(normalizeItem(null, LOOKUP), null)
})

test('normalizeItem falls back to building a URL from the shortcode', () => {
  const post = normalizeItem({ ...RAW, url: undefined }, LOOKUP)
  assert.equal(post.url, 'https://www.instagram.com/p/Dbk3zQ9onUa/')
})

test('handles are matched case-insensitively', () => {
  assert.equal(normalizeItem({ ...RAW, ownerUsername: 'Nitsa_Club' }, LOOKUP)?.handle, 'nitsa_club')
})

test('buildInput uses a PER-PROFILE results limit and defaults to basicData', () => {
  const input = buildInput([{ handle: 'a' }, { handle: 'b' }], { postsPerSource: 6 })
  assert.deepEqual(input.username, ['a', 'b'])
  assert.equal(input.resultsLimit, 6) // per profile, not 12 total
  assert.equal(input.dataDetailLevel, 'basicData')
  assert.ok(!('onlyPostsNewerThan' in input))
})

test('buildInput passes the watermark through only when set', () => {
  const opts = { postsPerSource: 6, onlyPostsNewerThan: '2026-08-01T00:00:00.000Z' }
  assert.equal(buildInput([{ handle: 'a' }], opts).onlyPostsNewerThan, '2026-08-01T00:00:00.000Z')
  assert.ok(!('onlyPostsNewerThan' in buildInput([{ handle: 'a' }], { postsPerSource: 6 })))
})

// --- incremental watermark ---
// This exists to stop paying for the same backlog every run, so getting it
// wrong either costs money or silently loses posts.

const SOURCES = [{ handle: 'aaa' }, { handle: 'bbb' }]

test('computeWatermark returns null on a cold start', () => {
  assert.equal(computeWatermark(SOURCES, []), null)
  assert.equal(computeWatermark(SOURCES, null), null)
  assert.equal(computeWatermark([], [{ handle: 'aaa', createdAt: '2026-08-01T00:00:00Z' }]), null)
})

test('computeWatermark returns null if ANY source has no stored posts', () => {
  // Otherwise a newly added page inherits the others' watermark and loses its
  // history permanently.
  const posts = [{ handle: 'aaa', createdAt: '2026-08-05T00:00:00.000Z' }]
  assert.equal(computeWatermark(SOURCES, posts), null)
})

test('computeWatermark uses the OLDEST per-source newest post, minus a buffer', () => {
  const posts = [
    { handle: 'aaa', createdAt: '2026-08-05T00:00:00.000Z' },
    { handle: 'aaa', createdAt: '2026-07-01T00:00:00.000Z' },
    { handle: 'bbb', createdAt: '2026-08-03T00:00:00.000Z' }, // oldest newest
  ]
  // 2026-08-03 minus the 2-day buffer.
  assert.equal(computeWatermark(SOURCES, posts), '2026-08-01T00:00:00.000Z')
})

test('computeWatermark ignores unparseable dates', () => {
  const posts = [
    { handle: 'aaa', createdAt: 'garbage' },
    { handle: 'aaa', createdAt: '2026-08-05T00:00:00.000Z' },
    { handle: 'bbb', createdAt: '2026-08-05T00:00:00.000Z' },
  ]
  assert.equal(computeWatermark(SOURCES, posts), '2026-08-03T00:00:00.000Z')
})
