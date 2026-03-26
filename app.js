const HN_API = 'https://hacker-news.firebaseio.com/v0';
const HN_ALGOLIA = 'https://hn.algolia.com/api/v1';
const HN_ITEM_URL = 'https://news.ycombinator.com/item?id=';

const MODE_ENDPOINTS = {
  top:      () => `${HN_API}/topstories.json`,
  new:      () => `${HN_API}/newstories.json`,
  best:     () => `${HN_API}/beststories.json`,
  ask:      () => `${HN_API}/askstories.json`,
  show:     () => `${HN_API}/showstories.json`,
  job:      () => `${HN_API}/jobstories.json`,
};

const ALGOLIA_COMMENTS_URL =
  `${HN_ALGOLIA}/search_by_date?tags=comment&hitsPerPage=100`;

// ── State ──────────────────────────────────────────────────────────────────
let ids      = [];
let index    = 0;
let mode     = 'top';
let loading  = false;
let handlingPopstate = false;

const ALL_MODES = ['top', 'new', 'best', 'comments', 'ask', 'show', 'job'];
const modePositions = Object.fromEntries(ALL_MODES.map(m => [m, 0]));

// ── HTML sanitizer ─────────────────────────────────────────────────────────
const ALLOWED_TAGS = new Set(['a','b','i','em','strong','p','br','code','pre','ul','ol','li']);
const ALLOWED_ATTRS = { a: ['href'] };

function sanitizeNode(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) {
        const allowed = ALLOWED_ATTRS[tag] || [];
        if (!allowed.includes(attr.name)) {
          child.removeAttribute(attr.name);
        } else if (attr.name === 'href') {
          const val = (child.getAttribute('href') || '').trim();
          if (/^javascript:/i.test(val) || /^data:/i.test(val)) {
            child.removeAttribute('href');
          }
        }
      }
      if (tag === 'a') {
        child.setAttribute('rel', 'noopener noreferrer');
        child.setAttribute('target', '_blank');
      }
      sanitizeNode(child);
    } else if (child.nodeType !== Node.TEXT_NODE) {
      child.remove();
    }
  }
}

function sanitizeHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}

// ── Persistence ────────────────────────────────────────────────────────────
function saveState(addToHistory = false) {
  modePositions[mode] = index;
  const positions = ALL_MODES.map(m => modePositions[m]).join(',');
  const hash = `#${mode}:${positions}`;
  const fn = addToHistory ? 'pushState' : 'replaceState';
  history[fn]({ mode, index }, '', hash);
  try {
    localStorage.setItem('hn_state', `${mode}:${positions}`);
  } catch (_) {}
}

function loadSavedState() {
  const raw = location.hash.slice(1) ||
    (() => { try { return localStorage.getItem('hn_state') || ''; } catch(_) { return ''; } })();

  if (raw) {
    const [m, posStr] = raw.split(':');
    const normalised = m === 'past' ? 'best' : m;
    if (normalised && ALL_MODES.includes(normalised) && posStr) {
      posStr.split(',').forEach((v, i) => {
        const n = parseInt(v, 10);
        if (!isNaN(n)) modePositions[ALL_MODES[i]] = n;
      });
      return { savedMode: normalised, savedIndex: modePositions[normalised] };
    }
  }
  return { savedMode: 'top', savedIndex: 0 };
}

// ── DOM refs ───────────────────────────────────────────────────────────────
const elLoading   = document.getElementById('loading');
const elError     = document.getElementById('error');
const elErrorMsg  = document.getElementById('error-msg');
const elRetry     = document.getElementById('retry-btn');
const elCard      = document.getElementById('card');
const elControls  = document.getElementById('nav-controls');
const elAnnounce  = document.getElementById('sr-announce');
const elDoomView  = document.getElementById('doom-view');
const elDoomFeed  = document.getElementById('doom-feed');
const elDoomMore  = document.getElementById('doom-more');

const elTitle     = document.getElementById('card-title');
const elUrl       = document.getElementById('card-url');
const elScore     = document.getElementById('card-score');
const elAuthor    = document.getElementById('card-author');
const elTime      = document.getElementById('card-time');
const elComments  = document.getElementById('card-comments');
const elText      = document.getElementById('card-text');
const elType      = document.getElementById('card-type');
const elIndex     = document.getElementById('card-index');

const elPrev      = document.getElementById('prev-btn');
const elNext      = document.getElementById('next-btn');
const elProgress  = document.getElementById('progress-fill');

// ── Helpers ────────────────────────────────────────────────────────────────
function timeAgo(unix) {
  const diff = Math.floor((Date.now() / 1000) - unix);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtCount(n) {
  if (n == null) return '';
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
}

function setVisible(el, show) {
  el.hidden = !show;
}

function showLoading() {
  setVisible(elLoading, true);
  setVisible(elError, false);
  setVisible(elCard, false);
  setVisible(elControls, false);
}

function showError(msg) {
  elErrorMsg.textContent = msg;
  setVisible(elLoading, false);
  setVisible(elError, true);
  setVisible(elCard, false);
  setVisible(elControls, false);
}

function showCard() {
  setVisible(elLoading, false);
  setVisible(elError, false);
  setVisible(elCard, true);
  setVisible(elControls, true);
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Load mode ──────────────────────────────────────────────────────────────
async function loadMode(m, resumeIndex = 0) {
  // Guard: doom is handled separately and has no MODE_ENDPOINTS entry
  if (m === 'doom' || (!MODE_ENDPOINTS[m] && m !== 'comments')) return;

  mode  = m;
  index = 0;
  ids   = [];

  showLoading();

  try {
    if (m === 'comments') {
      const data = await fetchJSON(ALGOLIA_COMMENTS_URL);
      ids = data.hits || [];
    } else {
      // Use local `m` (not global `mode`) so concurrent doom activation
      // can't swap mode mid-flight and break the endpoint lookup
      const list = await fetchJSON(MODE_ENDPOINTS[m]());
      ids = list.slice(0, 100);
    }

    if (!ids.length) {
      showError('No items found for this mode.');
      return;
    }

    index = Math.min(resumeIndex, ids.length - 1);
    await renderCurrent();
  } catch (e) {
    showError(`Failed to load: ${e.message}`);
  }
}

// ── Render current item ────────────────────────────────────────────────────
async function renderCurrent(addToHistory = false) {
  if (!ids.length) return;

  showLoading();
  loading = true;

  try {
    let item;

    if (mode === 'comments') {
      const hit = ids[index];
      item = {
        id:          hit.objectID,
        type:        'comment',
        title:       null,
        url:         null,
        score:       null,
        by:          hit.author,
        time:        hit.created_at_i,
        descendants: null,
        text:        hit.comment_text,
        story_title: hit.story_title,
        story_id:    hit.story_id,
      };
    } else {
      item = await fetchJSON(`${HN_API}/item/${ids[index]}.json`);
    }

    renderItem(item);
    showCard();
    saveState(addToHistory);
  } catch (e) {
    showError(`Failed to load item: ${e.message}`);
  } finally {
    loading = false;
  }
}

function renderItem(item) {
  if (!item) { showError('Item not found.'); return; }

  elType.textContent = item.type || '';
  elIndex.textContent = `${index + 1} / ${ids.length}`;

  let displayTitle;
  if (item.type === 'comment') {
    displayTitle = item.story_title ? `Re: ${item.story_title}` : 'Comment';
  } else {
    displayTitle = item.title || '(no title)';
  }
  elTitle.textContent = displayTitle;
  document.title = `${displayTitle} | HN Reader`;

  if (elAnnounce) {
    elAnnounce.textContent = `${index + 1} of ${ids.length}: ${displayTitle}`;
  }

  const hasUrl = item.url && item.type !== 'comment';
  setVisible(elUrl, hasUrl);
  if (hasUrl) {
    elUrl.href        = item.url;
    elUrl.textContent = new URL(item.url).hostname.replace(/^www\./, '');
  }

  if (item.score != null) {
    elScore.textContent = `▲ ${item.score}`;
    setVisible(elScore, true);
  } else {
    setVisible(elScore, false);
  }

  elAuthor.textContent = item.by ? `by ${item.by}` : '';
  setVisible(elAuthor, !!item.by);

  elTime.textContent = item.time ? timeAgo(item.time) : '';
  setVisible(elTime, !!item.time);

  const commentCount = item.descendants;
  const itemId = item.id || item.objectID;
  const hnLink = `${HN_ITEM_URL}${itemId}`;
  if (item.type === 'comment') {
    elComments.textContent = 'view thread';
    elComments.href = item.story_id ? `${HN_ITEM_URL}${item.story_id}` : hnLink;
    setVisible(elComments, true);
  } else if (commentCount != null) {
    elComments.textContent = `${commentCount} comment${commentCount !== 1 ? 's' : ''}`;
    elComments.href = hnLink;
    setVisible(elComments, true);
  } else {
    setVisible(elComments, false);
  }

  if (item.text) {
    elText.innerHTML = sanitizeHTML(item.text);
    setVisible(elText, true);
  } else {
    elText.innerHTML = '';
    setVisible(elText, false);
  }

  elProgress.style.width = `${((index + 1) / ids.length) * 100}%`;
  elPrev.disabled = index === 0;
  elNext.disabled = index === ids.length - 1;

  // Store destination for card click handler
  const dest = item.url || (item.type === 'comment' && item.story_id
    ? `${HN_ITEM_URL}${item.story_id}`
    : `${HN_ITEM_URL}${item.id}`);
  elCard.dataset.href = dest;

  window.__currentItem = item;
}

// ── Navigation ─────────────────────────────────────────────────────────────
async function go(delta) {
  if (loading) return;
  const next = index + delta;
  if (next < 0 || next >= ids.length) return;
  index = next;
  await renderCurrent(true);
}

elPrev.addEventListener('click', () => go(-1));
elNext.addEventListener('click', () => go(1));

// Whole-card click → article URL (skip clicks on links/buttons inside the card)
elCard.addEventListener('click', (e) => {
  if (e.target.closest('a, button')) return;
  const dest = elCard.dataset.href;
  if (dest) window.open(dest, '_blank', 'noopener noreferrer');
});

// ── Swipe gestures (card mode only) ───────────────────────────────────────
let touchStartY = 0;
let touchStartX = 0;

document.addEventListener('touchstart', (e) => {
  touchStartY = e.touches[0].clientY;
  touchStartX = e.touches[0].clientX;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (mode === 'doom') return;
  const dy = touchStartY - e.changedTouches[0].clientY;
  const dx = touchStartX - e.changedTouches[0].clientX;
  // Require mostly vertical swipe (dy > dx) and minimum 50px distance
  if (Math.abs(dy) < 50 || Math.abs(dy) < Math.abs(dx)) return;
  go(dy > 0 ? 1 : -1); // swipe up → next, swipe down → prev
}, { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (mode === 'doom') return; // doom scroll uses native scroll
  switch (e.key) {
    case 'ArrowLeft':  case 'h': go(-1); break;
    case 'ArrowRight': case 'l': go(1);  break;
    case 'k': go(-1); break;
    case 'j': go(1);  break;
    case 'o': {
      const item = window.__currentItem;
      if (item?.url) window.open(item.url, '_blank', 'noopener');
      else if (item?.type === 'comment' && item?.story_id)
        window.open(`${HN_ITEM_URL}${item.story_id}`, '_blank', 'noopener');
      break;
    }
    case 'c': {
      const item = window.__currentItem;
      if (item?.type === 'comment' && item?.story_id)
        window.open(`${HN_ITEM_URL}${item.story_id}`, '_blank', 'noopener');
      else {
        const id = item?.id || item?.objectID;
        if (id) window.open(`${HN_ITEM_URL}${id}`, '_blank', 'noopener');
      }
      break;
    }
  }
});

window.addEventListener('popstate', async (e) => {
  if (handlingPopstate) return;
  handlingPopstate = true;
  try {
    const state = e.state;
    if (!state) return;
    document.querySelectorAll('.mode-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === state.mode));
    if (state.mode === 'doom') {
      activateDoom();
    } else if (state.mode !== mode) {
      await loadMode(state.mode, state.index);
    } else {
      index = state.index;
      await renderCurrent(false);
    }
  } finally {
    handlingPopstate = false;
  }
});

// ── Mode switcher ──────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    modePositions[mode] = index;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const m = btn.dataset.mode;
    if (m === 'doom') {
      activateDoom();
    } else {
      deactivateDoom();
      loadMode(m, modePositions[m] || 0);
    }
  });
});

elRetry.addEventListener('click', () => { if (mode !== 'doom') loadMode(mode); });

// ════════════════════════════════════════════════════════════════════════════
// ── Doom scroll ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

const DOOM_FEEDS = ['top', 'new', 'best', 'ask', 'show', 'job', 'comments'];
const DOOM_BATCH = 8;

// SVG icon strings
const SVG_HEART = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
const SVG_COMMENT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
const SVG_SHARE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

// Doom state
let doomSubMode  = 'sequential';
let doomQueue    = []; // [{sourceMode, id?, hit?}]
let doomQueuePos = 0;
let doomFetching = false;
let doomObserver = null;
let doomSourcesReady = false;

function setDoomPostHeight() {
  const headerH = document.querySelector('header')?.offsetHeight ?? 44;
  const tabsH   = document.querySelector('.doom-tabs-bar')?.offsetHeight ?? 44;
  document.documentElement.style.setProperty(
    '--doom-post-h', `calc(100dvh - ${headerH + tabsH}px)`);
}

function activateDoom() {
  mode = 'doom';
  document.body.classList.add('doom-active');
  setVisible(elLoading, false);
  setVisible(elError, false);
  setVisible(elCard, false);
  setVisible(elControls, false);
  setVisible(elDoomView, true);
  document.title = 'Doom Scroll | HN Reader';
  setDoomPostHeight();
  startDoom(doomSubMode);
}

window.addEventListener('resize', () => {
  if (mode === 'doom') setDoomPostHeight();
});

function deactivateDoom() {
  document.body.classList.remove('doom-active');
  setVisible(elDoomView, false);
  teardownDoomObserver();
  doomQueue    = [];
  doomQueuePos = 0;
  doomFetching = false;
  doomSourcesReady = false;
}

function teardownDoomObserver() {
  if (doomObserver) { doomObserver.disconnect(); doomObserver = null; }
}

async function startDoom(subMode) {
  doomSubMode  = subMode;
  doomQueue    = [];
  doomQueuePos = 0;
  doomFetching = false;
  doomSourcesReady = false;
  teardownDoomObserver();

  // Clear existing posts (keep doom-more loader at end)
  [...elDoomFeed.children].forEach(el => {
    if (el.id !== 'doom-more') el.remove();
  });
  setVisible(elDoomMore, true);

  // Update active tab
  document.querySelectorAll('.doom-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.doom === subMode));

  // Fetch all ID lists in parallel, then start rendering
  const caps = { top: 500, new: 500, best: 500 };
  const results = await Promise.allSettled(
    DOOM_FEEDS.map(async m => {
      if (m === 'comments') {
        const data = await fetchJSON(ALGOLIA_COMMENTS_URL);
        return (data.hits || []).map(hit => ({ sourceMode: 'comments', hit }));
      }
      const list = await fetchJSON(MODE_ENDPOINTS[m]());
      const cap = caps[m] || list.length;
      return list.slice(0, cap).map(id => ({ sourceMode: m, id }));
    })
  );

  const sourceArrays = results.map(r => r.status === 'fulfilled' ? r.value : []);

  if (subMode === 'sequential') {
    doomQueue = sourceArrays.flat();
  } else {
    // Mix: Fisher-Yates shuffle across all sources
    const all = sourceArrays.flat();
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    doomQueue = all;
  }

  doomSourcesReady = true;

  // Set up intersection observer on the loader element
  doomObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) renderDoomBatch();
  }, { rootMargin: '300px' });
  doomObserver.observe(elDoomMore);

  // Kick off first batch immediately
  renderDoomBatch();
}

async function renderDoomBatch() {
  if (doomFetching || !doomSourcesReady) return;
  if (doomQueuePos >= doomQueue.length) {
    setVisible(elDoomMore, false);
    return;
  }

  doomFetching = true;
  setVisible(elDoomMore, true);

  const slice = doomQueue.slice(doomQueuePos, doomQueuePos + DOOM_BATCH);
  doomQueuePos += slice.length;

  const settled = await Promise.allSettled(
    slice.map(async entry => {
      if (entry.hit) {
        return {
          id:          entry.hit.objectID,
          type:        'comment',
          by:          entry.hit.author,
          time:        entry.hit.created_at_i,
          text:        entry.hit.comment_text,
          story_title: entry.hit.story_title,
          story_id:    entry.hit.story_id,
          score:       null,
          descendants: null,
          url:         null,
          sourceMode:  'comments',
        };
      }
      const item = await fetchJSON(`${HN_API}/item/${entry.id}.json`);
      if (item) item.sourceMode = entry.sourceMode;
      return item;
    })
  );

  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      elDoomFeed.insertBefore(buildDoomPost(result.value), elDoomMore);
    }
  }

  setVisible(elDoomMore, doomQueuePos < doomQueue.length);
  doomFetching = false;

  // If sentinel is still visible after rendering, fetch another batch
  if (doomQueuePos < doomQueue.length) {
    const rect = elDoomMore.getBoundingClientRect();
    if (rect.top < window.innerHeight + 300) renderDoomBatch();
  }
}

function buildDoomPost(item) {
  const isComment = item.type === 'comment';
  const hasUrl    = !isComment && !!item.url;
  const hnUrl     = `${HN_ITEM_URL}${isComment && item.story_id ? item.story_id : item.id}`;
  const caption   = isComment
    ? (item.story_title ? `Re: ${item.story_title}` : 'Comment')
    : (item.title || '(no title)');

  const post = document.createElement('article');
  post.className = 'dp';

  // Whole-card click → main URL (article or HN thread), except on action links/buttons
  const cardDest = hasUrl ? item.url : hnUrl;
  post.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    window.open(cardDest, '_blank', 'noopener noreferrer');
  });

  // ── Header ────────────────────────────────────────────────────────────────
  const header = el('header', 'dp-header');

  const avatar = el('div', 'dp-avatar');
  const avatarImg = el('img', 'dp-avatar-img');
  avatarImg.src = `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(item.by || 'unknown')}`;
  avatarImg.alt = item.by || 'unknown';
  avatarImg.width = 38;
  avatarImg.height = 38;
  avatar.appendChild(avatarImg);

  const meta = el('div', 'dp-meta');
  const authorEl = el('span', 'dp-author');
  authorEl.textContent = item.by || 'unknown';
  const infoEl = el('span', 'dp-info');
  const infoParts = [];
  if (hasUrl) { try { infoParts.push(new URL(item.url).hostname.replace(/^www\./, '')); } catch(_) {} }
  if (item.time) infoParts.push(timeAgo(item.time));
  infoEl.textContent = infoParts.join(' · ');
  meta.append(authorEl, infoEl);

  const badge = el('span', 'dp-badge');
  badge.textContent = item.sourceMode || item.type || 'story';

  header.append(avatar, meta, badge);
  post.appendChild(header);

  // ── Content ───────────────────────────────────────────────────────────────
  if (hasUrl) {
    const preview = document.createElement('a');
    preview.className = 'dp-link-preview';
    preview.href = item.url;
    preview.target = '_blank';
    preview.rel = 'noopener noreferrer';

    const hostEl = el('div', 'dp-link-host');
    try { hostEl.textContent = new URL(item.url).hostname.replace(/^www\./, ''); } catch(_) {}

    const titleEl = el('div', 'dp-link-title');
    titleEl.textContent = item.title || '';

    preview.append(hostEl, titleEl);
    post.appendChild(preview);
  }

  if (item.text) {
    const textBody = el('div', 'dp-text-body');
    textBody.innerHTML = sanitizeHTML(item.text);
    post.appendChild(textBody);
  }

  // ── Caption ───────────────────────────────────────────────────────────────
  const captionEl = el('div', 'dp-caption');
  const authorStrong = document.createElement('strong');
  authorStrong.textContent = (item.by || 'unknown') + ' ';
  captionEl.append(authorStrong, document.createTextNode(caption));
  post.appendChild(captionEl);

  // ── Actions ───────────────────────────────────────────────────────────────
  const actions = el('footer', 'dp-actions');
  const actLeft = el('div', 'dp-actions-left');

  // Heart / upvotes
  const likeBtn = el('button', 'dp-btn dp-like');
  likeBtn.title = 'Points';
  likeBtn.innerHTML = SVG_HEART;
  if (item.score != null) {
    const s = el('span'); s.textContent = fmtCount(item.score);
    likeBtn.appendChild(s);
  }
  actLeft.appendChild(likeBtn);

  // Comment bubble
  const commentLink = document.createElement('a');
  commentLink.className = 'dp-btn dp-comment';
  commentLink.href = hnUrl;
  commentLink.target = '_blank';
  commentLink.rel = 'noopener noreferrer';
  commentLink.title = 'View on HN';
  commentLink.innerHTML = SVG_COMMENT;
  if (item.descendants != null) {
    const s = el('span'); s.textContent = fmtCount(item.descendants);
    commentLink.appendChild(s);
  } else if (isComment) {
    const s = el('span'); s.textContent = 'thread';
    commentLink.appendChild(s);
  }
  actLeft.appendChild(commentLink);

  actions.appendChild(actLeft);

  // Share / open article (right side)
  if (hasUrl) {
    const openLink = document.createElement('a');
    openLink.className = 'dp-btn dp-share';
    openLink.href = item.url;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.title = 'Open article';
    openLink.innerHTML = SVG_SHARE;
    actions.appendChild(openLink);
  }

  post.appendChild(actions);
  return post;
}

// Tiny element factory
function el(tag, cls = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// ── Doom tab switcher ──────────────────────────────────────────────────────
document.querySelectorAll('.doom-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.doom !== doomSubMode) startDoom(tab.dataset.doom);
  });
});

// ── Boot ───────────────────────────────────────────────────────────────────
const { savedMode, savedIndex } = loadSavedState();

document.querySelectorAll('.mode-btn').forEach(b => {
  b.classList.toggle('active', b.dataset.mode === savedMode);
});

loadMode(savedMode, savedIndex);
