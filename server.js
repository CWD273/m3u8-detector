import express from 'express';
import axios from 'axios';
import cheerio from 'cheerio';
import morgan from 'morgan';
import { URL } from 'url';

const app = express();
const PORT = process.env.PORT || 5173;

// Optional: allowlist domains you control or trust
const ALLOWLIST = [
  // "example.com",
];

app.use(morgan('tiny'));
app.use(express.static('public')); // serves the client files

// Basic CORS for your frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Range'
  );
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Validate target URLs against optional allowlist
function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (ALLOWLIST.length === 0) return true;
    return ALLOWLIST.some((d) => u.hostname.endsWith(d));
  } catch {
    return false;
  }
}

// Extract candidate m3u8 URLs from HTML and inline JS
function extractM3U8(html, baseUrl) {
  const $ = cheerio.load(html);
  const candidates = new Set();

  // Direct DOM references
  $('source[src*=".m3u8"], a[href*=".m3u8"], video[src*=".m3u8"]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('href');
    if (src) candidates.add(new URL(src, baseUrl).href);
  });

  // Script tags containing m3u8 strings
  $('script').each((_, el) => {
    const text = $(el).html() || '';
    const re = /(https?:\/\/[^\s"'\\]+?\.m3u8[^\s"'\\]*)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      try {
        const abs = new URL(m[1], baseUrl).href;
        candidates.add(abs);
      } catch {}
    }
  });

  // Raw HTML scan (fallback)
  const re = /(https?:\/\/[^\s"'\\]+?\.m3u8[^\s"'\\]*)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl).href;
      candidates.add(abs);
    } catch {}
  }

  return Array.from(candidates);
}

// Extract helpful page metadata for display
function extractMeta(html) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || null;
  const ogTitle = $('meta[property="og:title"]').attr('content') || null;
  const ogVideo = $('meta[property="og:video"]').attr('content') || null;
  const ogDescription = $('meta[property="og:description"]').attr('content') || null;
  return { title, ogTitle, ogVideo, ogDescription };
}

// Scrape endpoint: finds m3u8s and returns metadata
app.get('/scrape', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing ?url=' });
  if (!isAllowed(target)) return res.status(403).json({ error: 'Domain not allowed' });

  try {
    const response = await axios.get(target, {
      maxRedirects: 5,
      headers: {
        // Forward a realistic UA; some sites deliver different markup
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      },
      responseType: 'text',
      timeout: 15000
    });

    const html = response.data;
    const baseUrl = response.request?.res?.responseUrl || target;
    const m3u8Urls = extractM3U8(html, baseUrl);
    const meta = extractMeta(html);

    // Prefer an obvious candidate if multiple exist (simple heuristic)
    const best =
      m3u8Urls.find((u) => /master|index|playlist/i.test(u)) || m3u8Urls[0] || null;

    res.json({
      ok: true,
      page: baseUrl,
      meta,
      m3u8Urls,
      best
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || 'Fetch failed'
    });
  }
});

// Stream proxy: relays HLS playlists, segments, captions
app.get('/proxy', async (req, res) => {
  const src = req.query.src;
  if (!src) return res.status(400).send('Missing ?src=');
  if (!isAllowed(src)) return res.status(403).send('Domain not allowed');

  try {
    const upstream = await axios.get(src, {
      responseType: 'stream',
      headers: {
        // Forward UA and range for segments
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Range: req.headers['range'] || undefined,
        Referer: new URL(src).origin
      },
      maxRedirects: 5,
      timeout: 20000,
      validateStatus: (s) => s >= 200 && s < 400
    });

    // Mirror key caching headers when possible
    const passthrough = [
      'content-type',
      'content-length',
      'accept-ranges',
      'content-range',
      'etag',
      'last-modified',
      'cache-control',
      'access-control-allow-origin'
    ];
    passthrough.forEach((h) => {
      const v = upstream.headers[h];
      if (v) res.setHeader(h, v);
    });

    // Ensure CORS for the client
    res.setHeader('Access-Control-Allow-Origin', '*');

    upstream.data.pipe(res);
  } catch (err) {
    res.status(502).send(`Upstream error: ${err.message || 'Bad gateway'}`);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} to use the client app.`);
});
