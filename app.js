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

// Comments mode uses Algolia search API (returns comment items directly)
const ALGOLIA_COMMENTS_URL =
  `${HN_ALGOLIA}/search_by_date?tags=comment&hitsPerPage=100`;

// ── State ──────────────────────────────────────────────────────────────────
let ids      = [];       // list of story IDs (or algolia hits for comments)
let index    = 0;        // current position
let mode     = 'top';
let loading  = false;
let handlingPopstate = false;

// Per-mode remembered positions
const ALL_MODES = ['top', 'new', 'best', 'comments', 'ask', 'show', 'job'];
const modePositions = Object.fromEntries(ALL_MODES.map(m => [m, 0]));

// ── HTML sanitizer ─────────────────────────────────────────────────────────
// HN API returns HTML in comment/text fields; sanitize before injecting.
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
    // Accept old "past" key from saved state and map it to "best"
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
  mode  = m;
  index = 0;
  ids   = [];

  showLoading();

  try {
    if (mode === 'comments') {
      const data = await fetchJSON(ALGOLIA_COMMENTS_URL);
      // Store algolia hits so we can render them directly
      ids = data.hits || [];
    } else {
      const list = await fetchJSON(MODE_ENDPOINTS[mode]());
      ids = list.slice(0, 100); // cap at 100
    }

    if (!ids.length) {
      showError('No items found for this mode.');
      return;
    }

    // Restore saved position, clamped to the current list length
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
      // Map algolia comment hit to a consistent shape
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
  if (!item) {
    showError('Item not found.');
    return;
  }

  // Type badge
  elType.textContent = item.type || '';

  // Index counter
  elIndex.textContent = `${index + 1} / ${ids.length}`;

  // Title
  let displayTitle;
  if (item.type === 'comment') {
    displayTitle = item.story_title ? `Re: ${item.story_title}` : 'Comment';
  } else {
    displayTitle = item.title || '(no title)';
  }
  elTitle.textContent = displayTitle;

  // Update browser tab title
  document.title = `${displayTitle} | HN Reader`;

  // Announce to screen readers
  if (elAnnounce) {
    elAnnounce.textContent = `${index + 1} of ${ids.length}: ${displayTitle}`;
  }

  // URL
  const hasUrl = item.url && item.type !== 'comment';
  setVisible(elUrl, hasUrl);
  if (hasUrl) {
    elUrl.href        = item.url;
    elUrl.textContent = new URL(item.url).hostname.replace(/^www\./, '');
  }

  // Score
  if (item.score != null) {
    elScore.textContent = `▲ ${item.score}`;
    setVisible(elScore, true);
  } else {
    setVisible(elScore, false);
  }

  // Author
  elAuthor.textContent = item.by ? `by ${item.by}` : '';
  setVisible(elAuthor, !!item.by);

  // Time
  elTime.textContent = item.time ? timeAgo(item.time) : '';
  setVisible(elTime, !!item.time);

  // Comments link
  const commentCount = item.descendants;
  const itemId = item.id || item.objectID;
  const hnLink = `${HN_ITEM_URL}${itemId}`;
  if (item.type === 'comment') {
    elComments.textContent = 'view thread';
    elComments.href = item.story_id
      ? `${HN_ITEM_URL}${item.story_id}`
      : hnLink;
    setVisible(elComments, true);
  } else if (commentCount != null) {
    elComments.textContent = `${commentCount} comment${commentCount !== 1 ? 's' : ''}`;
    elComments.href = hnLink;
    setVisible(elComments, true);
  } else {
    setVisible(elComments, false);
  }

  // Body text (Ask HN posts, job posts, comments) — sanitized before injection
  if (item.text) {
    elText.innerHTML = sanitizeHTML(item.text);
    setVisible(elText, true);
  } else {
    elText.innerHTML = '';
    setVisible(elText, false);
  }

  // Progress bar
  elProgress.style.width = `${((index + 1) / ids.length) * 100}%`;

  // Prev / next button state
  elPrev.disabled = index === 0;
  elNext.disabled = index === ids.length - 1;

  // Store for keyboard shortcuts
  window.__currentItem = item;
}

// ── Navigation ─────────────────────────────────────────────────────────────
async function go(delta) {
  if (loading) return;
  const next = index + delta;
  if (next < 0 || next >= ids.length) return;
  index = next;
  await renderCurrent(true); // push to browser history
}

elPrev.addEventListener('click', () => go(-1));
elNext.addEventListener('click', () => go(1));

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  switch (e.key) {
    case 'ArrowLeft':
    case 'h':
      go(-1); break;
    case 'ArrowRight':
    case 'l':
      go(1); break;
    case 'k':
      go(-1); break;
    case 'j':
      go(1); break;
    case 'o': {
      const item = window.__currentItem;
      if (item?.url) {
        window.open(item.url, '_blank', 'noopener');
      } else if (item?.type === 'comment' && item?.story_id) {
        // No article URL for comments — open story thread instead
        window.open(`${HN_ITEM_URL}${item.story_id}`, '_blank', 'noopener');
      }
      break;
    }
    case 'c': {
      const item = window.__currentItem;
      // For comments, open the parent story thread (not the bare comment page)
      if (item?.type === 'comment' && item?.story_id) {
        window.open(`${HN_ITEM_URL}${item.story_id}`, '_blank', 'noopener');
      } else {
        const id = item?.id || item?.objectID;
        if (id) window.open(`${HN_ITEM_URL}${id}`, '_blank', 'noopener');
      }
      break;
    }
  }
});

// ── Browser history (back/forward) ─────────────────────────────────────────
window.addEventListener('popstate', async (e) => {
  if (handlingPopstate) return;
  handlingPopstate = true;
  try {
    const state = e.state;
    if (!state) return;
    if (state.mode !== mode) {
      mode = state.mode;
      document.querySelectorAll('.mode-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === mode));
      await loadMode(mode, state.index);
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
    // Snapshot current position before leaving this mode
    modePositions[mode] = index;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadMode(btn.dataset.mode, modePositions[btn.dataset.mode]);
  });
});

elRetry.addEventListener('click', () => loadMode(mode));

// ── Boot ───────────────────────────────────────────────────────────────────
const { savedMode, savedIndex } = loadSavedState();

// Highlight the correct mode button
document.querySelectorAll('.mode-btn').forEach(b => {
  b.classList.toggle('active', b.dataset.mode === savedMode);
});

loadMode(savedMode, savedIndex);
