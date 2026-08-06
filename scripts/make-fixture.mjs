#!/usr/bin/env node
/**
 * Generate a fake store so the site can be checked locally without an Apify
 * token or a single credit spent.
 *
 *   node scripts/make-fixture.mjs           # fresh feed
 *   node scripts/make-fixture.mjs --stale   # backdate it to prove the staleness banner
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { scorePost } from './promo.mjs'

const STORE_DIR = resolve(process.env.STORE_DIR ?? 'store')
const MEDIA_DIR = join(STORE_DIR, 'media')
const stale = process.argv.includes('--stale')

const SOURCES = [
  { handle: 'hoerberlin', name: 'Hör Berlin' },
  { handle: 'boilerroomtv', name: 'Boiler Room' },
  { handle: 'tresorberlin', name: 'Tresor' },
]

const CAPTIONS = [
  // News — should score 0
  'Announcing the autumn programme. Six weeks, three rooms, one very long Sunday.',
  'Interview: thirty years of the Roland TR-909 and the engineers who kept it alive.',
  'Recording from Saturday night is now up on our channel. Closing set included.',
  'A word on our new sound system. New rotary mixer, rebuilt bass array.',
  // Promo — should score > 0
  'FINAL RELEASE 🎟 Tickets on sale now — link in bio!',
  'Prevendite aperte! Biglietti disponibili da domani mattina alle 10:00',
  'GIVEAWAY 🎉 Tag a friend for 2x2 tickets. Winners announced Friday.',
  'New merch drop. Shop now, 20% off with promo code WAREHOUSE.',
  'Vorverkauf startet Freitag. #techno #berlin #rave #club #warehouse #acid #detroit #minimal #electro #dub #industrial #hardgroove #afterhours',
]

const now = Date.now()

const posts = CAPTIONS.flatMap((caption, i) =>
  SOURCES.map((source, s) => {
    const id = `fixture${i}${s}`
    const post = {
      id,
      code: `FX${i}${s}`,
      url: 'https://www.instagram.com/p/EXAMPLE/',
      handle: source.handle,
      sourceName: source.name,
      // Spread across the last ~10 days so relative timestamps vary.
      createdAt: new Date(now - (i * 3 + s) * 8 * 3_600_000).toISOString(),
      caption,
      likeCount: Math.round(400 + i * 137 + s * 921),
      commentCount: Math.round(3 + i * 4 + s),
      isVideo: i % 3 === 0,
      isCarousel: i % 4 === 0,
      isPinned: false,
      // Prove the platform-flag path lights up the strongest chip.
      isPaidPartnership: i === 7,
      image: `media/${id}.svg`,
      promoScore: 0,
      promoReasons: [],
    }
    const { score, reasons } = scorePost(post)
    post.promoScore = score
    post.promoReasons = reasons
    return post
  }),
).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

await mkdir(MEDIA_DIR, { recursive: true })

// A placeholder image per post so thumbnail layout is exercised for real.
// SVG rather than JPEG: the browser lays both out identically, and this keeps
// the fixture readable instead of hiding a base64 blob in the script.
for (const [i, post] of posts.entries()) {
  await writeFile(join(MEDIA_DIR, `${post.id}.svg`), placeholderSvg(post, i))
}

const generatedAt = stale
  ? new Date(now - 4 * 24 * 3_600_000).toISOString()
  : new Date(now - 90 * 60_000).toISOString()

await writeFile(
  join(STORE_DIR, 'feed.json'),
  JSON.stringify(
    {
      generatedAt,
      sources: SOURCES,
      counts: {
        total: posts.length,
        new: posts.length,
        promo: posts.filter((p) => p.promoScore > 0).length,
      },
      posts,
    },
    null,
    2,
  ),
)

console.log(
  `fixture: ${posts.length} posts (${posts.filter((p) => p.promoScore > 0).length} promo) -> ${STORE_DIR}` +
    (stale ? '  [backdated 4 days]' : ''),
)

/**
 * A placeholder thumbnail. Deliberately varies aspect ratio between posts
 * (portrait / square / landscape) so the card layout is checked against the
 * real range Instagram returns, not one convenient shape.
 */
function placeholderSvg(post, i) {
  const shapes = [
    [1080, 1350], // portrait, the Instagram default
    [1080, 1080], // square
    [1080, 608], // landscape
    [1080, 1920], // reel, the tallest case
  ]
  const [w, h] = shapes[i % shapes.length]
  const bars = Array.from({ length: 14 }, (_, b) => {
    const bh = Math.round(h * (0.12 + ((b * 7 + i * 3) % 10) / 18))
    const bw = Math.round(w / 20)
    return `<rect x="${Math.round(w * 0.06 + b * (w * 0.066))}" y="${Math.round((h - bh) / 2)}" width="${bw}" height="${bh}" rx="${Math.round(bw / 3)}" fill="${b % 3 === 0 ? '#c6ff3d' : '#3a3a44'}"/>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<rect width="${w}" height="${h}" fill="#1b1b20"/>
${bars}
<text x="${Math.round(w / 2)}" y="${h - 40}" fill="#8e8e99" font-family="sans-serif" font-size="34" text-anchor="middle">${post.handle} · ${w}×${h}</text>
</svg>`
}
