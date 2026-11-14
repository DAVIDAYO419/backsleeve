# Backsleeve

Paste a Spotify album link, get a poster. Tweak the layout, colors and toggles, then download a 2400 px wide PNG.

## Run it

```
cd backsleeve
node server.js
```

Open http://localhost:3000. Needs Node 18 or newer and has no dependencies.

## Deploy it

Any host that runs a Node process works (Render, Railway, Fly.io). Start command is `node server.js`. The server reads `PORT` from the environment.

`render.yaml` is included for Render. The server also works with a flat layout, where `index.html` sits next to `server.js` instead of inside `public/`. That makes it easy to upload from a phone.

## Spotify data

The server tries these in order:

1. The Spotify Web API, if `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are set. Copy `.env.example` to `.env` and fill them in. Free keys come from https://developer.spotify.com/dashboard.
2. Spotify's public embed page, which needs no keys.
3. Spotify oEmbed, which only gives the title and cover. The Edit tab lets you add the tracklist by hand.

The Spotify code on the poster comes from Spotify's scannable code service and is requested in the poster's colors.

## Files

- `public/index.html` is the whole front end. Posters are drawn on a canvas.
- `server.js` handles `/api/album`, the image proxy `/api/img` and static files.
- `test/parse.test.js` checks link parsing and the embed parser. Run `npm test`.

## Status

The poster drawing, controls, download and poster codes were tested in headless Chrome with a mock server. The live Spotify requests were not tested because the build sandbox cannot reach Spotify. If a lookup fails, check the server log first.
