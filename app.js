/**
 * Techno Feed — client.
 *
 * Reads feed.json (shipped alongside this file by the deploy workflow) and
 * renders it as a reverse-chronological inbox. No framework, no build step.
 *
 * Read-state and filter preferences live in localStorage, so they are per
 * device and survive reloads. Nothing is sent anywhere.
 */

const STORAGE = {
  seen: 'tf:seen',
  hidePromo: 'tf:hidePromo',
  unreadOnly: 'tf:unreadOnly',
  source: 'tf:source',
}

/** Show a staleness warning once the pipeline looks like it has stopped running. */
const STALE_AFTER_HOURS = 36

const el = {
  feed: document.getElementById('feed'),
  updatedAt: document.getElementById('updatedAt'),
  banner: document.getElementById('banner'),
  sourceChips: document.getElementById('sourceChips'),
  hidePromo: document.getElementById('hidePromo'),
  unreadOnly: document.getElementById('unreadOnly'),
  visibleCount: document.getElementById('visibleCount'),
  emptyState: document.getElementById('emptyState'),
  markAllRead: document.getElementById('markAllRead'),
}

const state = {
  posts: [],
  sources: [],
  seen: loadSeen(),
  activeSource: localStorage.getItem(STORAGE.source) || 'all',
}

init()

async function init() {
  el.hidePromo.checked = localStorage.getItem(STORAGE.hidePromo) === '1'
  el.unreadOnly.checked = localStorage.getItem(STORAGE.unreadOnly) === '1'

  el.hidePromo.addEventListener('change', () => {
    localStorage.setItem(STORAGE.hidePromo, el.hidePromo.checked ? '1' : '0')
    render()
  })
  el.unreadOnly.addEventListener('change', () => {
    localStorage.setItem(STORAGE.unreadOnly, el.unreadOnly.checked ? '1' : '0')
    render()
  })
  el.markAllRead.addEventListener('click', () => {
    for (const post of visiblePosts()) state.seen.add(post.id)
    saveSeen()
    render()
  })

  let feed
  try {
    // Cache-bust so a freshly deployed feed is not masked by a stale SW/HTTP cache.
    const res = await fetch(`feed.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    feed = await res.json()
  } catch (err) {
    el.updatedAt.textContent = 'Could not load feed'
    showBanner(
      `<strong>No feed data yet.</strong> If you just set this up, run the “Update feed” workflow in the Actions tab. (${escapeHtml(err.message)})`,
    )
    return
  }

  state.posts = Array.isArray(feed.posts) ? feed.posts : []
  state.sources = Array.isArray(feed.sources) ? feed.sources : []

  // Drop a remembered source filter that no longer exists in sources.json,
  // otherwise the feed silently renders empty with no visible cause.
  if (state.activeSource !== 'all' && !state.sources.some((s) => s.handle === state.activeSource)) {
    state.activeSource = 'all'
    localStorage.removeItem(STORAGE.source)
  }

  showUpdatedAt(feed.generatedAt)
  pruneSeen()
  renderSourceChips()
  render()
}

function showUpdatedAt(generatedAt) {
  const when = generatedAt ? new Date(generatedAt) : null
  if (!when || Number.isNaN(when.getTime())) {
    el.updatedAt.textContent = 'Last updated: unknown'
    return
  }

  el.updatedAt.textContent = `Last updated ${relativeTime(when)}`

  const ageHours = (Date.now() - when.getTime()) / 3_600_000
  if (ageHours > STALE_AFTER_HOURS) {
    showBanner(
      `<strong>This feed is ${Math.floor(ageHours / 24)} day(s) old.</strong> ` +
        `The updater may be failing — check the Actions tab, and whether this month’s Apify credits ran out.`,
    )
  }
}

function showBanner(html) {
  el.banner.innerHTML = html
  el.banner.hidden = false
}

function renderSourceChips() {
  const chips = [{ handle: 'all', name: 'All' }, ...state.sources]
  el.sourceChips.replaceChildren(
    ...chips.map(({ handle, name }) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'chip'
      btn.textContent = name || handle
      btn.setAttribute('aria-pressed', String(handle === state.activeSource))
      btn.addEventListener('click', () => {
        state.activeSource = handle
        localStorage.setItem(STORAGE.source, handle)
        for (const c of el.sourceChips.children) c.setAttribute('aria-pressed', 'false')
        btn.setAttribute('aria-pressed', 'true')
        render()
      })
      return btn
    }),
  )
}

function visiblePosts() {
  return state.posts.filter((post) => {
    if (state.activeSource !== 'all' && post.handle !== state.activeSource) return false
    if (el.hidePromo.checked && post.promoScore > 0) return false
    if (el.unreadOnly.checked && state.seen.has(post.id)) return false
    return true
  })
}

function render() {
  const posts = visiblePosts()

  const unread = state.posts.filter((p) => !state.seen.has(p.id)).length
  el.visibleCount.textContent = `${posts.length} shown · ${unread} unread`

  el.feed.replaceChildren(...posts.map(renderCard))

  if (posts.length === 0) {
    el.emptyState.hidden = false
    el.emptyState.textContent = state.posts.length
      ? 'Nothing matches these filters.'
      : 'No posts stored yet.'
  } else {
    el.emptyState.hidden = true
  }
}

function renderCard(post) {
  const card = document.createElement('article')
  card.className = 'card'
  if (state.seen.has(post.id)) card.classList.add('is-read')

  const head = document.createElement('div')
  head.className = 'card-head'

  const source = document.createElement('span')
  source.className = 'source'
  source.textContent = post.sourceName || post.handle

  const time = document.createElement('time')
  time.className = 'time'
  time.dateTime = post.createdAt
  time.textContent = relativeTime(new Date(post.createdAt))
  time.title = new Date(post.createdAt).toLocaleString()

  head.append(source, time)

  if (post.promoScore > 0) {
    const chip = document.createElement('span')
    chip.className = `promo promo-${post.promoScore}`
    chip.textContent = 'PROMO'
    // The score is only trustworthy if you can see what triggered it.
    chip.title = `Promo score ${post.promoScore}/3 — ${(post.promoReasons || []).join(', ')}`
    head.append(chip)
  }

  card.append(head)

  if (post.image) {
    const link = document.createElement('a')
    link.href = post.url || '#'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.className = 'thumb-link'
    link.addEventListener('click', () => markRead(post, card))

    const img = document.createElement('img')
    img.className = 'thumb'
    img.src = post.image
    img.alt = ''
    img.loading = 'lazy'
    img.decoding = 'async'

    link.append(img)
    if (post.isVideo || post.isCarousel) {
      const badge = document.createElement('span')
      badge.className = 'media-badge'
      badge.textContent = post.isCarousel ? '❏' : '▶'
      badge.title = post.isCarousel ? 'Carousel' : 'Video'
      link.append(badge)
    }
    card.append(link)
  }

  if (post.caption) {
    const caption = document.createElement('p')
    caption.className = 'caption clamped'
    caption.textContent = post.caption
    // Long club captions are mostly hashtags; expand on demand rather than
    // letting one post fill the screen.
    caption.addEventListener('click', () => caption.classList.toggle('clamped'))
    card.append(caption)
  }

  const foot = document.createElement('div')
  foot.className = 'card-foot'

  const open = document.createElement('a')
  open.href = post.url || '#'
  open.target = '_blank'
  open.rel = 'noopener noreferrer'
  open.className = 'open-link'
  open.textContent = 'Open on Instagram ↗'
  open.addEventListener('click', () => markRead(post, card))

  const stats = document.createElement('span')
  stats.className = 'stats'
  const bits = []
  if (post.likeCount != null) bits.push(`${formatCount(post.likeCount)} likes`)
  if (post.commentCount != null) bits.push(`${formatCount(post.commentCount)} comments`)
  stats.textContent = bits.join(' · ')

  const toggleRead = document.createElement('button')
  toggleRead.type = 'button'
  toggleRead.className = 'ghost-btn small'
  toggleRead.textContent = state.seen.has(post.id) ? 'Unread' : 'Read'
  toggleRead.addEventListener('click', () => {
    if (state.seen.has(post.id)) state.seen.delete(post.id)
    else state.seen.add(post.id)
    saveSeen()
    render()
  })

  foot.append(open, stats, toggleRead)
  card.append(foot)

  return card
}

function markRead(post, card) {
  if (state.seen.has(post.id)) return
  state.seen.add(post.id)
  saveSeen()
  card.classList.add('is-read')
  // Deliberately not re-rendering: yanking the card out from under a click that
  // just opened a new tab is disorienting. It disappears on the next render.
  const unread = state.posts.filter((p) => !state.seen.has(p.id)).length
  el.visibleCount.textContent = `${visiblePosts().length} shown · ${unread} unread`
}

function loadSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE.seen) ?? '[]')
    return new Set(Array.isArray(raw) ? raw : [])
  } catch {
    return new Set()
  }
}

function saveSeen() {
  try {
    localStorage.setItem(STORAGE.seen, JSON.stringify([...state.seen]))
  } catch {
    /* quota exceeded — read state is a nicety, not worth breaking the page for */
  }
}

/** Forget ids that have aged out of the rolling window, so the set cannot grow forever. */
function pruneSeen() {
  const live = new Set(state.posts.map((p) => p.id))
  const before = state.seen.size
  for (const id of state.seen) if (!live.has(id)) state.seen.delete(id)
  if (state.seen.size !== before) saveSeen()
}

const RELATIVE_UNITS = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

function relativeTime(date) {
  if (!date || Number.isNaN(date.getTime())) return 'unknown'
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const diff = date.getTime() - Date.now()
  const abs = Math.abs(diff)
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit)
  }
  return rtf.format(Math.round(diff / 1000), 'second')
}

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
