#!/usr/bin/env node
/**
 * Re-apply promo scoring to an existing store, without touching the network.
 *
 * fetch.mjs already re-scores the whole backlog on every run, but that costs a
 * paid actor call. This lets you tune PROMO_PATTERNS against real captions for
 * free, which is the only practical way to iterate on the keyword list.
 *
 *   node scripts/rescore.mjs           # rewrite feed.json with fresh scores
 *   node scripts/rescore.mjs --dry     # report changes, write nothing
 *   node scripts/rescore.mjs --audit   # print every post with score + reasons
 */

import { readFile, writeFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { scorePost } from './promo.mjs'

const STORE_DIR = resolve(process.env.STORE_DIR ?? 'store')
const FEED_PATH = join(STORE_DIR, 'feed.json')
const dry = process.argv.includes('--dry')
const audit = process.argv.includes('--audit')

const feed = JSON.parse(await readFile(FEED_PATH, 'utf8'))
const changes = []

for (const post of feed.posts) {
  const before = post.promoScore ?? 0
  const { score, reasons } = scorePost(post)
  if (score !== before) changes.push({ post, before, after: score, reasons })
  post.promoScore = score
  post.promoReasons = reasons
}

feed.counts = {
  ...feed.counts,
  total: feed.posts.length,
  promo: feed.posts.filter((p) => p.promoScore > 0).length,
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 96)

if (audit) {
  for (const group of [0, 1, 2, 3]) {
    const posts = feed.posts.filter((p) => p.promoScore === group)
    if (!posts.length) continue
    console.log(`\n=== score ${group} — ${posts.length} posts ===`)
    for (const p of posts) {
      console.log(`  [${p.sourceName}] ${clean(p.caption)}`)
      if (p.promoReasons.length) console.log(`      ${p.promoReasons.join(', ')}`)
    }
  }
  console.log()
}

if (changes.length) {
  console.log(`${changes.length} score change(s):`)
  for (const c of changes) {
    console.log(`  ${c.before} -> ${c.after}  [${c.post.sourceName}] ${clean(c.post.caption)}`)
    if (c.reasons.length) console.log(`        ${c.reasons.join(', ')}`)
  }
} else {
  console.log('no score changes')
}

const promo = feed.counts.promo
console.log(
  `\ntotals: ${promo}/${feed.posts.length} flagged promo (${Math.round((promo / feed.posts.length) * 100)}%)`,
)

if (dry) {
  console.log('--dry: nothing written')
} else {
  const tmp = `${FEED_PATH}.tmp`
  await writeFile(tmp, JSON.stringify(feed, null, 2))
  await rename(tmp, FEED_PATH)
  console.log(`wrote ${FEED_PATH}`)
}
