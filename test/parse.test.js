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
