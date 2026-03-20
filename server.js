const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const KOSHAROT_BASE = 'https://www.kosharot.co.il';
const KOSHAROT_PAGE = `${KOSHAROT_BASE}/index2.php`;
const PAGE_PARAMS = { id: '51171', lang: 'HEB' };

// Cached search form config discovered from the site's HTML
let searchConfig = null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Browser-like request headers ────────────────────────────
function buildHeaders(referer = KOSHAROT_BASE + '/') {
  return {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
      'Version/17.0 Mobile/15E148 Safari/604.1',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    Referer: referer,
    'Upgrade-Insecure-Requests': '1',
  };
}

// ── Scoped CSS injected alongside the extracted HTML ────────
// All selectors are prefixed with .site-results so they only
// affect the extracted content block, not the rest of the app.
const SCOPED_CSS = `<style>
.site-results { direction: rtl; text-align: right; font-size: 0.88rem; line-height: 1.6; word-break: break-word; }
.site-results * { font-family: Arial, 'Helvetica Neue', sans-serif !important; box-sizing: border-box; }
.site-results table { width: 100%; border-collapse: collapse; margin: 8px 0; }
.site-results th { background: #1a4a8a; color: #fff; padding: 8px 10px; text-align: right; font-weight: 600; border: 1px solid #163d75; }
.site-results td { padding: 7px 10px; border: 1px solid #e0d8c0; text-align: right; vertical-align: top; }
.site-results tr:nth-child(even) td { background: #faf7f0; }
.site-results tr:hover td { background: #f0e8d0; transition: background 0.1s; }
.site-results a { color: #1a4a8a; text-decoration: none; }
.site-results a:hover { text-decoration: underline; }
.site-results img { max-width: 100%; height: auto; display: block; }
.site-results ul, .site-results ol { padding-right: 20px; margin: 6px 0; }
.site-results li { margin: 4px 0; }
.site-results p { margin: 6px 0; }
.site-results h1, .site-results h2, .site-results h3 { color: #1a4a8a; margin: 10px 0 4px; font-size: 1rem; }
.site-results div, .site-results span { max-width: 100%; }
</style>`;

// ── Extract and sanitize the relevant content from a full page ──
// Strips navigation/chrome, removes scripts and event handlers,
// then isolates the main content section and wraps it with
// scoped CSS so it renders cleanly inside the app.
function sanitizeAndExtract(fullHtml) {
  const $ = cheerio.load(fullHtml, { decodeEntities: false });

  // Remove structural non-content elements
  $('script, noscript, style, link, meta, iframe, object, embed, head').remove();
  $('nav, header, footer, aside').remove();

  // Remove elements that look like site chrome by class/id name.
  // Guard: don't remove elements that contain a <table> or <tr>
  // since those might be the actual product listing.
  const chromePatterns = [
    'nav', 'menu', 'header', 'footer', 'sidebar', 'breadcrumb',
    'ad', 'banner', 'cookie', 'popup', 'modal', 'overlay', 'logo', 'toolbar',
  ];
  chromePatterns.forEach((pat) => {
    $(`[class*="${pat}"], [id*="${pat}"]`).each((_, el) => {
      if (!$(el).find('table, tr').length) $(el).remove();
    });
  });

  // Strip event handlers and javascript: hrefs (XSS safety)
  $('*').each((_, el) => {
    const attribs = el.attribs || {};
    Object.keys(attribs).forEach((attr) => {
      if (attr.startsWith('on')) delete el.attribs[attr];
    });
    if (attribs.href && attribs.href.trim().toLowerCase().startsWith('javascript:')) {
      delete el.attribs.href;
    }
  });

  // Priority-ordered selectors for the main content / results area
  const contentSelectors = [
    '#results', '.results', '#search-results', '.search-results',
    '#content', '#main-content', '#main', '.main-content', '.content',
    'main', 'article',
    '#products', '.products', '.product-list', '.product-results',
    '.container', '#container',
  ];

  for (const sel of contentSelectors) {
    const $el = $(sel).first();
    if ($el.length && $el.text().trim().length > 30) {
      return `${SCOPED_CSS}<div class="site-results">${$el.html()}</div>`;
    }
  }

  // Fallback: find the largest table (likely the product data table)
  let bestTable = null;
  let bestScore = 0;
  $('table').each((_, el) => {
    const score = $(el).text().trim().length;
    if (score > bestScore) { bestScore = score; bestTable = el; }
  });
  if (bestTable && bestScore > 20) {
    return `${SCOPED_CSS}<div class="site-results">${$.html($(bestTable))}</div>`;
  }

  // Last resort: remaining body content with chrome already stripped
  const bodyHtml = $('body').html() || '';
  if (bodyHtml.trim().length > 30) {
    return `${SCOPED_CSS}<div class="site-results">${bodyHtml}</div>`;
  }

  return null; // truly empty – caller will return an error
}

// ── Auto-discover the search form on the site's main page ───
async function discoverSearchConfig(pageHtml) {
  const $ = cheerio.load(pageHtml, { decodeEntities: false });
  let config = null;

  $('form').each((_, form) => {
    const $form = $(form);
    const textInput = $form
      .find('input[type="text"], input[type="search"], input:not([type])')
      .first();
    if (!textInput.length) return;

    const action = $form.attr('action') || KOSHAROT_PAGE;
    const method = ($form.attr('method') || 'GET').toUpperCase();
    const inputName = textInput.attr('name') || 'q';

    const hidden = {};
    $form.find('input[type="hidden"]').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value') || '';
      if (name) hidden[name] = value;
    });

    config = { action, method, inputName, hidden };
    return false; // stop at first form with a text input
  });

  return config;
}

// ── Main search endpoint ─────────────────────────────────────
// Accepts ?q=QUERY&type=barcode|name
// type is used for logging only; search logic is identical.
app.get('/api/search', async (req, res) => {
  const { q, type } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'חסר טקסט לחיפוש' });
  }

  const query = q.trim();
  const websiteUrl =
    `${KOSHAROT_PAGE}?id=${PAGE_PARAMS.id}&lang=${PAGE_PARAMS.lang}` +
    `&q=${encodeURIComponent(query)}`;

  try {
    // Step 1: fetch main page for session cookies + form discovery
    let mainHtml = '';
    let cookies = '';
    try {
      const mainRes = await axios.get(KOSHAROT_PAGE, {
        params: PAGE_PARAMS,
        headers: buildHeaders(),
        timeout: 15000,
        responseType: 'arraybuffer',
        maxRedirects: 5,
      });
      cookies = (mainRes.headers['set-cookie'] || [])
        .map((c) => c.split(';')[0])
        .join('; ');
      mainHtml = iconv.decode(Buffer.from(mainRes.data), 'utf-8');
    } catch (err) {
      console.warn('Main page fetch failed:', err.message);
    }

    // Step 2: discover search form config once and cache it
    if (mainHtml && !searchConfig) {
      searchConfig = await discoverSearchConfig(mainHtml);
      console.log('Search config discovered:', searchConfig);
    }

    // Step 3: attempt the search using various GET parameter names
    const extraHeaders = cookies ? { Cookie: cookies } : {};
    const paramNames = searchConfig
      ? [searchConfig.inputName]
      : ['q', 'search', 'product', 'name', 'term', 'keyword', 'barcode'];

    let searchHtml = null;

    for (const param of paramNames) {
      try {
        const params = { ...PAGE_PARAMS, [param]: query };
        if (searchConfig?.hidden) Object.assign(params, searchConfig.hidden);

        const response = await axios.get(searchConfig?.action || KOSHAROT_PAGE, {
          params,
          headers: {
            ...buildHeaders(KOSHAROT_PAGE + '?' + new URLSearchParams(PAGE_PARAMS)),
            ...extraHeaders,
          },
          timeout: 15000,
          responseType: 'arraybuffer',
          maxRedirects: 5,
        });

        const raw = iconv.decode(Buffer.from(response.data), 'utf-8');
        if (response.status === 200 && raw.length > 500) {
          searchHtml = raw;
          console.log(`Search OK — param: "${param}", type: "${type || 'barcode'}", query: "${query}"`);
          break;
        }
      } catch (err) {
        console.warn(`Search param "${param}" failed:`, err.message);
      }
    }

    if (!searchHtml) {
      return res.json({
        success: false, query, websiteUrl,
        error: 'לא ניתן לקבל תוצאות מהאתר. פתח את האתר ישירות.',
      });
    }

    // Step 4: extract and sanitize the relevant content snippet
    const resultsHtml = sanitizeAndExtract(searchHtml);

    if (!resultsHtml) {
      return res.json({
        success: false, query, websiteUrl,
        error: 'לא נמצאו תוצאות לחיפוש זה.',
      });
    }

    res.json({ success: true, query, websiteUrl, resultsHtml });

  } catch (err) {
    console.error('Unexpected error in /api/search:', err.message);
    res.json({
      success: false, query, websiteUrl,
      error: 'שגיאה בחיפוש. נסה שוב.',
    });
  }
});

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n🔍 סורק כשרות פסח - Passover Kosher Scanner`);
  console.log(`   Running at: http://localhost:${PORT}\n`);
});
