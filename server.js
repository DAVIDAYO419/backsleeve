'use strict';
/*
  Backsleeve server. Zero dependencies, needs Node 18 or newer.

  GET /api/album?link=...   Spotify album link in, album JSON out
  GET /api/img?u=...        image proxy for Spotify cover art and Spotify codes
  GET /api/health           mode check
  everything else           static files from ./public

  Data sources, tried in order:
    1. Spotify Web API, when SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are set
    2. The public Spotify embed page, which needs no keys
    3. Spotify oEmbed, which only returns the title and the cover
*/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Tiny .env loader so the project has no dependencies.
try {
  const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env file, fine */ }

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
// Normal layout serves ./public. A flat layout (index.html next to server.js, easier to upload
// from a phone) serves only index.html so the server code and .env are never exposed.
const HAS_PUBLIC = fs.existsSync(path.join(__dirname, 'public'));
const PUBLIC_DIR = HAS_PUBLIC ? path.join(__dirname, 'public') : __dirname;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- link parsing ---------- */

const SHORT_HOSTS = new Set(['spotify.link', 'spotify.app.link', 'spoti.fi']);

function parseSpotifyInput(input) {
  const s = String(input || '').trim();
  let m = s.match(/spotify:(album|track):([A-Za-z0-9]{22})/);
  if (m) return { type: m[1], id: m[2] };
  m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(album|track)\/([A-Za-z0-9]{22})/);
  if (m) return { type: m[1], id: m[2] };
  if (/^[A-Za-z0-9]{22}$/.test(s)) return { type: 'album', id: s };
  return null;
}

async function resolveShortLink(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch (e) { return null; }
  for (let hop = 0; hop < 4; hop++) {
    if (url.hostname === 'open.spotify.com') return url.href;
    if (!SHORT_HOSTS.has(url.hostname)) return null;
    const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA } });
    const loc = r.headers.get('location');
    if (!loc) return null;
    url = new URL(loc, url);
  }
  return null;
}

/* ---------- Spotify Web API (optional) ---------- */

let tokenCache = { value: '', exp: 0 };

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp - 30000) return tokenCache.value;
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`Spotify token request failed (${r.status})`);
  const j = await r.json();
  tokenCache = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tokenCache.value;
}

async function albumIdFromTrack(id) {
  const token = await getToken();
  const r = await fetch(`https://api.spotify.com/v1/tracks/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new HttpError(404, 'Track not found');
  const j = await r.json();
  if (!j.album || !j.album.id) throw new HttpError(404, 'That track has no album');
  return j.album.id;
}

async function fromApi(id) {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };
  const r = await fetch(`https://api.spotify.com/v1/albums/${id}`, { headers });
  if (r.status === 404) throw new HttpError(404, 'Album not found');
  if (!r.ok) throw new Error(`Spotify API answered ${r.status}`);
  const a = await r.json();
  let items = (a.tracks && a.tracks.items) || [];
  let next = a.tracks && a.tracks.next;
  while (next && items.length < 300) {
    const rr = await fetch(next, { headers });
    if (!rr.ok) break;
    const p = await rr.json();
    items = items.concat(p.items || []);
    next = p.next;
  }
  const images = (a.images || []).slice().sort((x, y) => (y.width || 0) - (x.width || 0));
  return {
    id,
    title: a.name || '',
    artist: (a.artists || []).map(x => x.name).join(', '),
    year: String(a.release_date || '').slice(0, 4),
    tracks: items.map(t => t.name).filter(Boolean),
    cover: images[0] ? images[0].url : null,
    source: 'api'
  };
}

/* ---------- Embed page (no keys) ---------- */

function parseEmbedHtml(html, id) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Embed page had no data block');
  const data = JSON.parse(m[1]);
  const pp = data && data.props && data.props.pageProps;
  const e = (pp && pp.state && pp.state.data && (pp.state.data.entity || pp.state.data)) || null;
  if (!e || !Array.isArray(e.trackList)) throw new Error('Embed data was not in the expected shape');
  const srcs = ((e.coverArt && e.coverArt.sources) || (e.visualIdentity && e.visualIdentity.image) || [])
    .map(s => ({ url: s.url, w: s.width || s.maxWidth || 0 }))
    .filter(s => s.url)
    .sort((a, b) => b.w - a.w);
  const artist = Array.isArray(e.artists) && e.artists.length
    ? e.artists.map(a => a.name).filter(Boolean).join(', ')
    : (e.subtitle || '');
  let year = '';
  if (e.releaseDate) {
    const iso = e.releaseDate.isoString || e.releaseDate.year || '';
    year = String(iso).slice(0, 4);
  }
  return {
    id,
    title: e.name || e.title || '',
    artist,
    year,
    tracks: e.trackList.map(t => t.title).filter(Boolean),
    cover: srcs[0] ? srcs[0].url : null,
    source: 'embed'
  };
}

async function fromEmbed(id) {
  const r = await fetch(`https://open.spotify.com/embed/album/${id}`, {
    headers: { 'user-agent': UA, 'accept-language': 'en' }
  });
  if (r.status === 404) throw new HttpError(404, 'Album not found');
  if (!r.ok) throw new Error(`Embed page answered ${r.status}`);
  return parseEmbedHtml(await r.text(), id);
}

async function fromOembed(id) {
  const target = `https://open.spotify.com/album/${id}`;
  const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(target)}`, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`oEmbed answered ${r.status}`);
  const j = await r.json();
  return { id, title: j.title || '', artist: '', year: '', tracks: [], cover: j.thumbnail_url || null, source: 'oembed', partial: true };
}

/* ---------- album lookup with cache ---------- */

const albumCache = new Map();
const CACHE_MS = 60 * 60 * 1000;

async function getAlbum(id) {
  const hit = albumCache.get(id);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  const chain = [];
  if (CLIENT_ID && CLIENT_SECRET) chain.push(fromApi);
  chain.push(fromEmbed, fromOembed);
  let lastErr;
  for (const fn of chain) {
    try {
      const v = await fn(id);
      albumCache.set(id, { t: Date.now(), v });
      if (albumCache.size > 500) albumCache.delete(albumCache.keys().next().value);
      return v;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('Lookup failed');
}

// Spotify serves the same cover art from i.scdn.co and from image-cdn-*.spotifycdn.com.
// The 40 character id is a 16 character size code plus a 24 character hash. 0000b273 is the 640 px size.
function normalizeCover(url) {
  if (!url) return null;
  const m = String(url).match(/\/image\/ab67616d[0-9a-f]{8}([0-9a-f]{24})(?:[/?#]|$)/i);
  return m ? `https://i.scdn.co/image/ab67616d0000b273${m[1].toLowerCase()}` : url;
}

function withProxyCover(album) {
  const proxy = u => (u ? `api/img?u=${encodeURIComponent(u)}` : null);
  const main = normalizeCover(album.cover);
  return Object.assign({}, album, {
    cover: main,
    coverUrl: proxy(main),
    coverAltUrl: album.cover && album.cover !== main ? proxy(album.cover) : null
  });
}

/* ---------- helpers ---------- */

const hits = new Map();
function limited(ip, bucket, max) {
  const key = bucket + ip;
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now > h.reset) { h = { n: 0, reset: now + 60000 }; hits.set(key, h); }
  h.n++;
  if (hits.size > 5000) hits.clear();
  return h.n > max;
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'x';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const IMG_RULES = [
  { host: h => h === 'i.scdn.co', prefix: '/image/' },
  { host: h => /^image-cdn-[a-z0-9-]+\.spotifycdn\.com$/.test(h), prefix: '/image/' },
  { host: h => h === 'scannables.scdn.co', prefix: '/uri/' },
  { host: h => h === 'mosaic.scdn.co', prefix: '/' }
];
function imageAllowed(t) {
  return t.protocol === 'https:' && IMG_RULES.some(r => r.host(t.hostname) && t.pathname.startsWith(r.prefix));
}

async function handleImg(req, res, u) {
  let t;
  try { t = new URL(u.searchParams.get('u') || ''); } catch (e) { return sendJson(res, 400, { error: 'Bad image URL' }); }
  if (!imageAllowed(t)) {
    console.error('image blocked:', t.hostname + t.pathname);
    return sendJson(res, 403, { error: 'Image host not allowed' });
  }
  const r = await fetch(t, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !/^image\//.test(type)) {
    console.error('image fetch failed:', r.status, type, t.hostname + t.pathname);
    return sendJson(res, 502, { error: 'Image fetch failed' });
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) return sendJson(res, 502, { error: 'Image too large' });
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
  res.end(buf);
}

async function handleAlbum(req, res, u) {
  const input = u.searchParams.get('link') || '';
  let parsed = parseSpotifyInput(input);
  if (!parsed) {
    const resolved = await resolveShortLink(input);
    if (resolved) parsed = parseSpotifyInput(resolved);
  }
  if (!parsed) throw new HttpError(400, 'That does not look like a Spotify album link.');
  let id = parsed.id;
  if (parsed.type === 'track') {
    if (!(CLIENT_ID && CLIENT_SECRET)) throw new HttpError(400, 'Paste an album link. Track links need Spotify API keys on the server.');
    id = await albumIdFromTrack(id);
  }
  const album = await getAlbum(id);
  sendJson(res, 200, withProxyCover(album));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  if (!HAS_PUBLIC && rel !== '/index.html') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (u.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, mode: CLIENT_ID && CLIENT_SECRET ? 'spotify-api' : 'embed' });
    }
    if (u.pathname === '/api/album') {
      if (limited(clientIp(req), 'a', 40)) return sendJson(res, 429, { error: 'Too many requests. Try again in a minute.' });
      return await handleAlbum(req, res, u);
    }
    if (u.pathname === '/api/img') {
      if (limited(clientIp(req), 'i', 240)) return sendJson(res, 429, { error: 'Too many requests.' });
      return await handleImg(req, res, u);
    }
    return serveStatic(req, res, u.pathname);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    const msg = e instanceof HttpError ? e.message : 'Could not reach Spotify. Try again, or edit the poster by hand.';
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: msg });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Backsleeve running on http://localhost:${PORT} (${CLIENT_ID && CLIENT_SECRET ? 'Spotify API' : 'embed page'} mode)`);
  });
}

module.exports = { parseSpotifyInput, parseEmbedHtml, normalizeCover, imageAllowed, withProxyCover, server };
