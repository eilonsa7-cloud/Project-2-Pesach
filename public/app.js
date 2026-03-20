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

// ── DOM helpers ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function show(id)  { $(id).classList.remove('hidden'); }
function hide(id)  { $(id).classList.add('hidden'); }

// ── Scanner lifecycle ────────────────────────────────────────
function startScanner() {
  if (scanning) return;

  scanner = new Html5Qrcode('reader', {
    formatsToSupport: BARCODE_FORMATS,
    verbose: false,
  });

  const config = {
    fps: 10,
    // Rectangular viewfinder – better for 1D barcodes
    qrbox: { width: Math.min(window.innerWidth - 60, 280), height: 110 },
    aspectRatio: 1.5,
  };

  scanner
    .start(
      { facingMode: 'environment' }, // back camera
      config,
      onScanSuccess,
      () => {} // ignore per-frame "not found" errors silently
    )
    .then(() => {
      scanning = true;
      hide('btn-start');
      show('btn-stop');
    })
    .catch((err) => {
      console.error('Camera start error:', err);
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
  // Debounce – ignore duplicate scans within 3 seconds
  if (decodedText === lastScanned) return;
  lastScanned = decodedText;
  setTimeout(() => { lastScanned = null; }, 3000);

  // Vibrate on success if supported
  if (navigator.vibrate) navigator.vibrate([80, 40, 80]);

  // Stop scanning and trigger search
  stopScanner();
  triggerSearch(decodedText);
}

// ── Search flow ──────────────────────────────────────────────
function triggerSearch(barcode) {
  barcode = (barcode || '').trim();
  if (!barcode) {
    alert('נא להזין ברקוד');
    return;
  }

  // Update UI to loading state
  hide('results-section');
  hide('btn-start');
  show('loading');

  // Set the manual input field too
  $('manual-input').value = barcode;

  fetch(`/api/search?q=${encodeURIComponent(barcode)}`)
    .then((r) => r.json())
    .then((data) => showResults(data))
    .catch((err) => {
      console.error('Fetch error:', err);
      showResults({
        success: false,
        barcode,
        error: 'שגיאת רשת. בדוק חיבור אינטרנט ונסה שוב.',
        websiteUrl: `https://www.kosharot.co.il/index2.php?id=51171&lang=HEB`,
      });
    })
    .finally(() => hide('loading'));
}

// ── Display results ──────────────────────────────────────────
function showResults(data) {
  const { barcode, success, iframeHtml, websiteUrl, error } = data;

  // Show barcode badge
  $('barcode-badge').innerHTML =
    `ברקוד שנסרק:<strong>${escapeHtml(barcode || '')}</strong>`;

  // Set website link (always available)
  $('website-link').href = websiteUrl || '#';

  // Iframe with full website HTML
  if (success && iframeHtml) {
    const iframe = $('results-iframe');
    iframe.srcdoc = iframeHtml;
    show('results-iframe-wrap');
    hide('error-msg');
  } else {
    hide('results-iframe-wrap');

    if (error) {
      $('error-msg').textContent = error;
      show('error-msg');
    }
  }

  // Show the results section
  show('results-section');

  // Scroll to results
  $('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Restore scan button so user can scan another
  show('btn-start');
}

// ── Reset ────────────────────────────────────────────────────
function resetToScanner() {
  hide('results-section');
  $('manual-input').value = '';
  $('results-iframe').srcdoc = '';

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Auto-start scanner again
  startScanner();
}

// ── Utility ──────────────────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── Init on page load ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Auto-start scanner
  startScanner();
});
