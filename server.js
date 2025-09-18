import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import morgan from 'morgan';
import puppeteer from 'puppeteer';
import { URL } from 'url';

const app = express();
const PORT = process.env.PORT || 5173;
const ALLOWLIST = process.env.ALLOWLIST?.split(',').map(d => d.trim()) || [];

app.use(morgan('tiny'));
app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
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
  if (!target) return res.status(400).json({ ok: false, error: 'Missing ?url=' });
  if (!isAllowed(target)) return res.status(403).json({ ok: false, error: 'Domain not allowed' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: puppeteer.executablePath()
    });

    const page = await browser.newPage();
    const m3u8Urls = new Set();

    page.on('request', req => {
      const url = req.url();
      if (url.includes('.m3u8')) m3u8Urls.add(url);
    });

    await page.goto(target, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(5000);

    const finalUrl = page.url();
    const html = await page.content();

    // Log redirect behavior
    if (finalUrl !== target) {
      console.warn(`Redirected from ${target} to ${finalUrl}`);
    }

    // Log if HTML looks like an error page
    if (html.startsWith('<!DOCTYPE')) {
      console.warn('Received HTML page instead of stream content');
      console.log(html.slice(0, 500));
    }

    const meta = extractMeta(html);
    const urls = Array.from(m3u8Urls);
    const best = urls.find(u => /master|index|playlist/i.test(u)) || urls[0] || null;

    res.json({
      ok: true,
      page: finalUrl,
      meta,
      m3u8Urls: urls,
      best
    });
  } catch (err) {
    console.error('Scrape error:', err);
    res.status(500).json({ ok: false, error: err.message || 'Puppeteer failed' });
  } finally {
    if (browser) await browser.close();
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Range: req.headers['range'] || undefined,
        Referer: new URL(src).origin
      },
      maxRedirects: 5,
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 400
    });

    const passthrough = [
      'content-type', 'content-length', 'accept-ranges', 'content-range',
      'etag', 'last-modified', 'cache-control', 'access-control-allow-origin'
    ];
    passthrough.forEach(h => {
      const v = upstream.headers[h];
      if (v) res.setHeader(h, v);
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    upstream.data.pipe(res);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).send(`Upstream error: ${err.message || 'Bad gateway'}`);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
  
