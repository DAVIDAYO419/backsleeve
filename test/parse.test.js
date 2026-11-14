'use strict';
const assert = require('node:assert');
const { parseSpotifyInput, parseEmbedHtml } = require('../server.js');

const ID = '4aawyAB9vmqN3uQ7FjRGTy';
assert.deepStrictEqual(parseSpotifyInput(`https://open.spotify.com/album/${ID}?si=abc`), { type: 'album', id: ID });
assert.deepStrictEqual(parseSpotifyInput(`https://open.spotify.com/intl-de/album/${ID}`), { type: 'album', id: ID });
assert.deepStrictEqual(parseSpotifyInput(`https://open.spotify.com/embed/album/${ID}`), { type: 'album', id: ID });
assert.deepStrictEqual(parseSpotifyInput(`spotify:album:${ID}`), { type: 'album', id: ID });
assert.deepStrictEqual(parseSpotifyInput(ID), { type: 'album', id: ID });
assert.deepStrictEqual(parseSpotifyInput(`https://open.spotify.com/track/${ID}`), { type: 'track', id: ID });
assert.strictEqual(parseSpotifyInput('https://example.com/album/' + ID), null);
assert.strictEqual(parseSpotifyInput('hello'), null);

// Fixture follows the shape of Spotify's embed page as I understand it. It has not been checked against the live site.
const next = { props: { pageProps: { state: { data: { entity: {
  name: 'Test Album', artists: [{ name: 'A' }, { name: 'B' }], releaseDate: { isoString: '2019-05-17T00:00:00Z' },
  coverArt: { sources: [{ url: 'https://i.scdn.co/image/small', width: 64 }, { url: 'https://i.scdn.co/image/big', width: 640 }] },
  trackList: [{ title: 'One' }, { title: 'Two' }, { title: '' }]
} } } } } };
const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></html>`;
const out = parseEmbedHtml(html, ID);
assert.strictEqual(out.title, 'Test Album');
assert.strictEqual(out.artist, 'A, B');
assert.strictEqual(out.year, '2019');
assert.deepStrictEqual(out.tracks, ['One', 'Two']);
assert.strictEqual(out.cover, 'https://i.scdn.co/image/big');
assert.throws(() => parseEmbedHtml('<html></html>', ID));
console.log('parse tests passed');

// Cover handling
const { normalizeCover, imageAllowed, withProxyCover } = require('../server.js');
const HASH = 'a1ffb45c4e8a790cd77e1c33';
assert.strictEqual(normalizeCover(`https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02${HASH}`), `https://i.scdn.co/image/ab67616d0000b273${HASH}`);
assert.strictEqual(normalizeCover(`https://i.scdn.co/image/ab67616d00004851${HASH}`), `https://i.scdn.co/image/ab67616d0000b273${HASH}`);
assert.strictEqual(normalizeCover('https://i.scdn.co/image/something-else'), 'https://i.scdn.co/image/something-else');
assert.strictEqual(normalizeCover(null), null);
assert.ok(imageAllowed(new URL(`https://image-cdn-ig.spotifycdn.com/image/ab67616d00001e02${HASH}`)));
assert.ok(imageAllowed(new URL(`https://i.scdn.co/image/ab67616d0000b273${HASH}`)));
assert.ok(imageAllowed(new URL('https://scannables.scdn.co/uri/plain/png/ffffff/black/640/spotify:album:4aawyAB9vmqN3uQ7FjRGTy')));
assert.ok(!imageAllowed(new URL('https://evil.example.com/image/x')));
assert.ok(!imageAllowed(new URL('https://spotifycdn.com.evil.com/image/x')));
assert.ok(!imageAllowed(new URL('http://i.scdn.co/image/x')));
const w = withProxyCover({ cover: `https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02${HASH}` });
assert.ok(w.coverUrl.startsWith('api/img?u=') && w.coverAltUrl.startsWith('api/img?u='));
console.log('cover tests passed');
