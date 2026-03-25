const HN_API = 'https://hacker-news.firebaseio.com/v0';
const HN_ALGOLIA = 'https://hn.algolia.com/api/v1';
const HN_ITEM_URL = 'https://news.ycombinator.com/item?id=';

const MODE_ENDPOINTS = {
  top:      () => `${HN_API}/topstories.json`,
  new:      () => `${HN_API}/newstories.json`,
  past:     () => `${HN_API}/beststories.json`,
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

// Per-mode remembered positions
const ALL_MODES = ['top', 'new', 'past', 'comments', 'ask', 'show', 'job'];
const modePositions = Object.fromEntries(ALL_MODES.map(m => [m, 0]));

// ── Persistence ────────────────────────────────────────────────────────────
function saveState() {
  modePositions[mode] = index;
  // URL hash encodes current mode + all positions, survives refresh
  const positions = ALL_MODES.map(m => modePositions[m]).join(',');
  history.replaceState(null, '', `#${mode}:${positions}`);
  try {
    localStorage.setItem('hn_state', `${mode}:${positions}`);
  } catch (_) {}
}

function loadSavedState() {
  const raw = location.hash.slice(1) ||
    (() => { try { return localStorage.getItem('hn_state') || ''; } catch(_) { return ''; } })();

  if (raw) {
    const [m, posStr] = raw.split(':');
    if (m && ALL_MODES.includes(m) && posStr) {
      posStr.split(',').forEach((v, i) => {
        const n = parseInt(v, 10);
        if (!isNaN(n)) modePositions[ALL_MODES[i]] = n;
      });
      return { savedMode: m, savedIndex: modePositions[m] };
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
async function renderCurrent() {
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
    saveState();
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
  if (item.type === 'comment') {
    elTitle.textContent = item.story_title
      ? `Re: ${item.story_title}`
      : 'Comment';
  } else {
    elTitle.textContent = item.title || '(no title)';
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
    elComments.textContent = `${commentCount} comments`;
    elComments.href = hnLink;
    setVisible(elComments, true);
  } else {
    setVisible(elComments, false);
  }

  // Body text (Ask HN posts, job posts, comments)
  if (item.text) {
    elText.innerHTML = item.text; // HN already HTML-encodes content
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
  await renderCurrent();
}

elPrev.addEventListener('click', () => go(-1));
elNext.addEventListener('click', () => go(1));

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'k':
    case 'h':
      go(-1); break;
    case 'ArrowRight':
    case 'ArrowDown':
    case 'j':
    case 'l':
      go(1); break;
    case 'o':
      if (window.__currentItem?.url) window.open(window.__currentItem.url, '_blank', 'noopener');
      break;
    case 'c': {
      const id = window.__currentItem?.id || window.__currentItem?.objectID;
      if (id) window.open(`${HN_ITEM_URL}${id}`, '_blank', 'noopener');
      break;
    }
  }
});

// ── Mode switcher ──────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadMode(btn.dataset.mode, modePositions[btn.dataset.mode] || 0);
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
