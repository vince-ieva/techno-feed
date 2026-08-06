#!/usr/bin/env node
/**
 * Offline tests for the promo scorer and the actor adapter.
 * No network, no APIFY_TOKEN needed:  node scripts/test-promo.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { scorePost, extractHashtags, HASHTAG_STUFFING_THRESHOLD } from './promo.mjs'
import { normalizeItem, buildInput } from './normalize.mjs'

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

const LOOKUP = new Map([['hoerberlin', { handle: 'hoerberlin', name: 'Hör Berlin' }]])

const RAW = {
  id: '3245142029192513970',
  code: 'C0JD3tntcmy',
  url: 'https://www.instagram.com/p/C0JD3tntcmy/',
  createdAt: '2026-08-01T07:48:34.000Z',
  caption: 'Saturday recording is up',
  likeCount: 114,
  commentCount: 5,
  isPinned: false,
  isPaidPartnership: false,
  isVideo: true,
  isCarousel: false,
  owner: { username: 'hoerberlin', fullName: 'Hör' },
  image: { url: 'https://scontent.cdninstagram.com/v/thumb.jpg' },
}

test('normalizeItem maps the actor shape to our internal shape', () => {
  const post = normalizeItem(RAW, LOOKUP)
  assert.equal(post.id, '3245142029192513970')
  assert.equal(post.handle, 'hoerberlin')
  assert.equal(post.sourceName, 'Hör Berlin') // config name wins over owner.fullName
  assert.equal(post.createdAt, '2026-08-01T07:48:34.000Z')
  assert.equal(post.remoteImageUrl, 'https://scontent.cdninstagram.com/v/thumb.jpg')
  assert.equal(post.image, null)
  assert.equal(post.isVideo, true)
})

test('normalizeItem drops posts from accounts we did not request', () => {
  const foreign = { ...RAW, owner: { username: 'someoneelse' } }
  assert.equal(normalizeItem(foreign, LOOKUP), null)
})

test('normalizeItem drops items missing id, owner or a valid date', () => {
  assert.equal(normalizeItem({ ...RAW, id: undefined }, LOOKUP), null)
  assert.equal(normalizeItem({ ...RAW, owner: undefined }, LOOKUP), null)
  assert.equal(normalizeItem({ ...RAW, createdAt: 'not-a-date' }, LOOKUP), null)
  assert.equal(normalizeItem(null, LOOKUP), null)
})

test('normalizeItem falls back to building a URL from the shortcode', () => {
  const post = normalizeItem({ ...RAW, url: undefined }, LOOKUP)
  assert.equal(post.url, 'https://www.instagram.com/p/C0JD3tntcmy/')
})

test('handles are matched case-insensitively', () => {
  const post = normalizeItem({ ...RAW, owner: { username: 'HoerBerlin' } }, LOOKUP)
  assert.equal(post?.handle, 'hoerberlin')
})

test('buildInput caps maxItems globally across sources', () => {
  const input = buildInput([{ handle: 'a' }, { handle: 'b' }], { postsPerSource: 6 })
  assert.deepEqual(input.startUrls, [
    'https://www.instagram.com/a/',
    'https://www.instagram.com/b/',
  ])
  assert.equal(input.maxItems, 12)
})
