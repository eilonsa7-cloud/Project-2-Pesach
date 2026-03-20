/* ============================================================
   Pesach Barcode Scanner – Frontend Logic
   Uses html5-qrcode (loaded from CDN in index.html)
   ============================================================ */

'use strict';

// ── Scanner state ────────────────────────────────────────────
let scanner = null;
let scanning = false;
let lastScanned = null;

// Supported barcode formats for food products (EAN / UPC)
const BARCODE_FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
];

// ── History constants ────────────────────────────────────────
const HISTORY_KEY = 'pesach_scan_history';
const MAX_HISTORY = 30;

// ── DOM helpers ──────────────────────────────────────────────
// $ wraps getElementById for brevity
const $ = (id) => document.getElementById(id);

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

// ── Scanner lifecycle ────────────────────────────────────────
function startScanner() {
  if (scanning) return;

  scanner = new Html5Qrcode('reader', {
    formatsToSupport: BARCODE_FORMATS,
    verbose: false,
  });

  const config = {
    fps: 10,
    // Rectangular viewfinder suits 1D (product) barcodes better than a square
    qrbox: { width: Math.min(window.innerWidth - 60, 280), height: 110 },
    aspectRatio: 1.5,
  };

  scanner
    .start(
      { facingMode: 'environment' }, // back camera
      config,
      onScanSuccess,
      () => {} // per-frame "not found" – suppress noise
    )
    .then(() => {
      scanning = true;
      hide('btn-start');
      show('btn-stop');
    })
    .catch(() => {
      alert('לא ניתן לגשת למצלמה.\nוודא שנתת הרשאת מצלמה ונסה שוב.');
    });
}

function stopScanner() {
  if (!scanner || !scanning) return;
  scanner.stop().then(() => {
    scanning = false;
    hide('btn-stop');
    show('btn-start');
  });
}

// ── Scan success ─────────────────────────────────────────────
function onScanSuccess(decodedText) {
  // Debounce: ignore the same code within 3 s to prevent double-triggers
  if (decodedText === lastScanned) return;
  lastScanned = decodedText;
  setTimeout(() => { lastScanned = null; }, 3000);

  // Haptic feedback on supported devices
  if (navigator.vibrate) navigator.vibrate([80, 40, 80]);

  stopScanner();
  triggerSearch(decodedText, 'barcode');
}

// ── Search flow ──────────────────────────────────────────────
// query: the barcode number or product name string
// type:  'barcode' | 'name'
function triggerSearch(query, type) {
  query = (query || '').trim();
  type  = type || 'barcode';

  if (!query) {
    alert(type === 'barcode' ? 'נא להזין ברקוד' : 'נא להזין שם מוצר');
    return;
  }

  // Populate whichever input matches
  if (type === 'barcode') {
    $('manual-input').value = query;
  } else {
    $('name-input').value = query;
  }

  // UI: go to loading state
  hide('results-section');
  show('loading');
  hide('btn-start');

  fetch(`/api/search?q=${encodeURIComponent(query)}&type=${type}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => showResults(data, type))
    .catch(() =>
      showResults(
        {
          success: false,
          query,
          error: 'שגיאת רשת. בדוק חיבור אינטרנט ונסה שוב.',
          websiteUrl: 'https://www.kosharot.co.il/index2.php?id=51171&lang=HEB',
        },
        type
      )
    )
    .finally(() => hide('loading'));
}

// ── Display results ──────────────────────────────────────────
function showResults(data, type) {
  const { query, success, resultsHtml, websiteUrl, error } = data;

  // Badge: what was searched
  const label = type === 'barcode' ? 'ברקוד שנסרק' : 'חיפוש שם מוצר';
  $('search-badge').innerHTML =
    `${label}:<strong>${escapeHtml(query || '')}</strong>`;

  // Website fallback link (always set)
  $('website-link').href = websiteUrl || '#';

  if (success && resultsHtml) {
    // Inject sanitised HTML from the server into the results card.
    // The server already stripped <script> tags and on* attributes.
    $('results-content').innerHTML = resultsHtml;
    show('results-card');
    hide('error-msg');

    // Save to history only on a successful result
    saveToHistory(query, type);
  } else {
    hide('results-card');
    $('results-content').innerHTML = '';

    if (error) {
      $('error-msg').textContent = error;
      show('error-msg');
    }
  }

  show('results-section');
  $('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  show('btn-start'); // allow scanning another item immediately
}

// ── Reset UI ─────────────────────────────────────────────────
function resetToScanner() {
  hide('results-section');
  hide('results-card');
  hide('error-msg');
  $('manual-input').value = '';
  $('name-input').value   = '';
  $('results-content').innerHTML = '';

  window.scrollTo({ top: 0, behavior: 'smooth' });
  startScanner();
}

// ── History – persistence ────────────────────────────────────
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

// Prepend a new entry (deduplicated by query+type) and trim to MAX_HISTORY.
function saveToHistory(query, type) {
  const history = loadHistory().filter(
    (h) => !(h.query === query && h.type === type)
  );
  history.unshift({ query, type, timestamp: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  renderHistory();
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
}

// ── History – rendering ──────────────────────────────────────
function renderHistory() {
  const history = loadHistory();
  const list    = $('history-list');
  const clearBtn = $('btn-clear-history');

  // Toggle the clear button state
  if (clearBtn) clearBtn.disabled = history.length === 0;

  // Clear existing items
  list.innerHTML = '';

  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className   = 'history-empty';
    empty.textContent = 'אין היסטוריית חיפושים';
    list.appendChild(empty);
    return;
  }

  history.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'history-item';
    // Trigger a new search when tapping a history row
    row.addEventListener('click', () => triggerSearch(item.query, item.type));

    const icon = document.createElement('span');
    icon.className   = 'history-icon';
    icon.textContent = item.type === 'barcode' ? '📊' : '🔤';

    const textWrap = document.createElement('div');
    textWrap.className = 'history-text';

    const querySpan = document.createElement('span');
    querySpan.className   = 'history-query';
    querySpan.textContent = item.query;            // textContent avoids XSS
    querySpan.dir         = item.type === 'barcode' ? 'ltr' : 'auto';

    const timeSpan = document.createElement('span');
    timeSpan.className   = 'history-time';
    timeSpan.textContent = formatTimestamp(item.timestamp);

    textWrap.appendChild(querySpan);
    textWrap.appendChild(timeSpan);
    row.appendChild(icon);
    row.appendChild(textWrap);
    list.appendChild(row);
  });
}

// ── Utility helpers ──────────────────────────────────────────
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatTimestamp(ts) {
  const d   = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

  if (isToday) return time;

  const date = d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
  return `${date} ${time}`;
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderHistory(); // populate history panel from localStorage
  startScanner();  // auto-start camera
});
