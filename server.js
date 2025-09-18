import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio'; // ✅ fixed import
import morgan from 'morgan';
import { URL } from 'url';

const app = express();
const PORT = process.env.PORT || 5173;

// Optional domain allowlist
const ALLOWLIST = process.env.ALLOWLIST?.split(',').map(d => d.trim()) || [];

app.use(morgan('tiny'));
app.use(express.static('public'));

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

function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (ALLOWLIST.length === 0) return true;
    return ALLOWLIST.some(domain => u.hostname.endsWith(domain));
  } catch {
    return false;
  }
}

function extractM3U8(html, baseUrl) {
  const $ = cheerio.load(html);
  const urls = new Set();

  $('source[src*=".m3u8"], a[href*=".m3u8"], video[src*=".m3u8"]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('href');
    if (src) urls.add(new URL(src, baseUrl).href);
  });

  $('script').each((_, el) => {
    const text = $(el).html() || '';
    const re = /(https?:\/\/[^\s"'\\]+?\.m3u8[^\s"'\\]*)/gi;
    let match;
    while ((match = re.exec(text)) !== null) {
      try {
        urls.add(new URL(match[1], baseUrl).href);
      } catch {}
    }
  });

  const re = /(https?:\/\/[^\s"'\\]+?\.m3u8[^\s"'\\]*)/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      urls.add(new URL(match[1], baseUrl).href);
    } catch {}
  }

  return Array.from(urls);
}

function extractMeta(html) {
  const $ = cheerio.load(html);
  return {
    title: $('title').first().text().trim() || null,
    ogTitle: $('meta[property="og:title"]').attr('content') || null,
    ogVideo: $('meta[property="og:video"]').attr('content') || null,
    ogDescription: $('meta[property="og:description"]').attr('content') || null
  };
}

app.get('/scrape', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing ?url=' });
  if (!isAllowed(target)) return res.status(403).json({ error: 'Domain not allowed' });

  try {
    const response = await axios.get(target, {
      maxRedirects: 5,
      headers: {
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
    const best = m3u8Urls.find(u => /master|index|playlist/i.test(u)) || m3u8Urls[0] || null;

    res.json({ ok: true, page: baseUrl, meta, m3u8Urls, best });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Fetch failed' });
  }
});

app.get('/proxy', async (req, res) => {
  const src = req.query.src;
  if (!src) return res.status(400).send('Missing ?src=');
  if (!isAllowed(src)) return res.status(403).send('Domain not allowed');

  try {
    const upstream = await axios.get(src, {
      responseType: 'stream',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Range: req.headers['range'] || undefined,
        Referer: new URL(src).origin
      },
      maxRedirects: 5,
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 400
    });

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
    passthrough.forEach(h => {
      const v = upstream.headers[h];
      if (v) res.setHeader(h, v);
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    upstream.data.pipe(res);
  } catch (err) {
    res.status(502).send(`Upstream error: ${err.message || 'Bad gateway'}`);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
