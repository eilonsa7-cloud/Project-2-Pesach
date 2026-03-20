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

// Cached search form config (action URL, method, input name, hidden fields)
let searchConfig = null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Build browser-like headers so the website treats us as a real user
function buildHeaders(referer = KOSHAROT_BASE + '/') {
  return {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
      'Version/17.0 Mobile/15E148 Safari/604.1',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    Referer: referer,
    'Upgrade-Insecure-Requests': '1',
  };
}

// Rewrite relative URLs inside HTML to absolute kosharot.co.il URLs
// so when the HTML is shown inside srcdoc iframe, styles/images load correctly
function rewriteToAbsolute(html) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $('head').prepend(`<base href="${KOSHAROT_BASE}/">`);

  // Rewrite href and src attributes
  $('[href]').each((_, el) => {
    const val = $(el).attr('href');
    if (val && !val.startsWith('http') && !val.startsWith('//') && !val.startsWith('#') && !val.startsWith('mailto')) {
      $(el).attr('href', KOSHAROT_BASE + '/' + val.replace(/^\//, ''));
    }
  });
  $('[src]').each((_, el) => {
    const val = $(el).attr('src');
    if (val && !val.startsWith('http') && !val.startsWith('//') && !val.startsWith('data:')) {
      $(el).attr('src', KOSHAROT_BASE + '/' + val.replace(/^\//, ''));
    }
  });
  $('[action]').each((_, el) => {
    const val = $(el).attr('action');
    if (val && !val.startsWith('http')) {
      $(el).attr('action', KOSHAROT_BASE + '/' + val.replace(/^\//, ''));
    }
  });

  return $.html();
}

// Fetch a URL and return decoded HTML string
async function fetchHtml(url, params = {}, extraHeaders = {}) {
  const response = await axios.get(url, {
    params,
    headers: { ...buildHeaders(), ...extraHeaders },
    timeout: 15000,
    responseType: 'arraybuffer',
    maxRedirects: 5,
  });

  // Detect encoding from Content-Type or meta charset
  const contentType = response.headers['content-type'] || '';
  let encoding = 'utf-8';
  if (/charset=windows-1255/i.test(contentType) || /charset=iso-8859-8/i.test(contentType)) {
    encoding = 'windows-1255';
  }

  const raw = iconv.decode(Buffer.from(response.data), encoding);

  // Also check meta charset in the HTML itself
  if (/charset=windows-1255/i.test(raw) || /charset=iso-8859-8/i.test(raw)) {
    return iconv.decode(Buffer.from(response.data), 'windows-1255');
  }

  return raw;
}

// Discover the search form configuration from the main page
async function discoverSearchConfig(pageHtml) {
  const $ = cheerio.load(pageHtml, { decodeEntities: false });

  let config = null;

  // Find forms that contain text inputs (likely the search form)
  $('form').each((_, form) => {
    const $form = $(form);
    const textInput = $form.find('input[type="text"], input[type="search"], input:not([type])').first();
    if (textInput.length === 0) return;

    const action = $form.attr('action') || KOSHAROT_PAGE;
    const method = ($form.attr('method') || 'GET').toUpperCase();
    const inputName = textInput.attr('name') || 'q';

    // Collect all hidden fields
    const hidden = {};
    $form.find('input[type="hidden"]').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value') || '';
      if (name) hidden[name] = value;
    });

    config = { action, method, inputName, hidden };
    return false; // stop looping, found the form
  });

  return config;
}

// Extract product results from a search-result HTML page
function parseProducts($) {
  const products = [];
  const seen = new Set();

  // Strategy: find table rows, list items, or divs that look like products
  const candidates = [];

  $('table tr').each((_, el) => candidates.push($(el)));
  $('li').each((_, el) => candidates.push($(el)));
  $('div[class], p[class]').each((_, el) => candidates.push($(el)));

  for (const $el of candidates) {
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text.length < 5 || text.length > 800) continue;

    // Skip navigation-like elements
    const cls = ($el.attr('class') || '').toLowerCase();
    const id = ($el.attr('id') || '').toLowerCase();
    if (/nav|menu|header|footer|sidebar|ad|banner|logo|cookie/.test(cls + id)) continue;

    if (!seen.has(text)) {
      seen.add(text);
      products.push(text);
    }
  }

  return products.slice(0, 50); // cap results
}

// Main search endpoint
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'חסר ברקוד לחיפוש' });
  }

  const barcode = q.trim();
  const websiteUrl = `${KOSHAROT_PAGE}?id=${PAGE_PARAMS.id}&lang=${PAGE_PARAMS.lang}&q=${encodeURIComponent(barcode)}`;

  try {
    // Step 1: Fetch main page to discover search form & get session cookies
    let mainHtml;
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
      console.warn('Could not fetch main page:', err.message);
      mainHtml = '';
    }

    // Step 2: Discover search form if we got the page
    if (mainHtml && !searchConfig) {
      searchConfig = await discoverSearchConfig(mainHtml);
      console.log('Search config discovered:', searchConfig);
    }

    // Step 3: Build search request
    const extraHeaders = cookies ? { Cookie: cookies } : {};
    let searchHtml = null;

    // Try multiple search approaches in order
    const paramNames = searchConfig
      ? [searchConfig.inputName]
      : ['q', 'search', 'product', 'name', 'term', 'keyword', 'barcode'];

    for (const param of paramNames) {
      try {
        const params = { ...PAGE_PARAMS, [param]: barcode };
        if (searchConfig?.hidden) Object.assign(params, searchConfig.hidden);

        const response = await axios.get(
          searchConfig?.action || KOSHAROT_PAGE,
          {
            params,
            headers: { ...buildHeaders(KOSHAROT_PAGE + '?' + new URLSearchParams(PAGE_PARAMS)), ...extraHeaders },
            timeout: 15000,
            responseType: 'arraybuffer',
            maxRedirects: 5,
          }
        );

        const raw = iconv.decode(Buffer.from(response.data), 'utf-8');

        // Check if this looks like a real results page (not an error page)
        if (response.status === 200 && raw.length > 500) {
          searchHtml = raw;
          console.log(`Search succeeded with param: ${param}`);
          break;
        }
      } catch (err) {
        console.warn(`Search attempt with param "${param}" failed:`, err.message);
        continue;
      }
    }

    if (!searchHtml) {
      return res.json({
        success: false,
        barcode,
        websiteUrl,
        error: 'לא ניתן לקבל תוצאות מהאתר. לחץ על הכפתור למטה לפתיחת האתר.',
      });
    }

    // Step 4: Parse results & rewrite URLs for iframe display
    const $ = cheerio.load(searchHtml, { decodeEntities: false });
    const products = parseProducts($);
    const iframeHtml = rewriteToAbsolute(searchHtml);

    res.json({
      success: true,
      barcode,
      websiteUrl,
      iframeHtml,
      products,
    });
  } catch (err) {
    console.error('Unexpected error in /api/search:', err.message);
    res.json({
      success: false,
      barcode,
      websiteUrl,
      error: 'שגיאה בחיפוש. נסה שוב או פתח את האתר ישירות.',
    });
  }
});

// Health check
app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n🔍 סורק כשרות פסח - Passover Kosher Scanner`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`   Open this URL in your phone browser (must be on same network)\n`);
});
