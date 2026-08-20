# Mapillary Photo Map — Morgan Hill / Gilroy

A single-page map of my [Mapillary](https://www.mapillary.com/) photo uploads around
Morgan Hill and Gilroy, CA. Points are colour-coded by the account that uploaded
them; clicking one opens a panel with the photo and its metadata.

Plain HTML/CSS/JS with Leaflet from a CDN. **No build step** — what's committed is
what GitHub Pages serves.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Entry point. Loads Leaflet + markercluster from unpkg, then `config.js` and `app.js`. |
| `config.js` | Everything you'd want to change: token, bbox, accounts, colours. |
| `app.js` | Fetching, map, legend, detail panel. |
| `styles.css` | All styling. |

## Setup

Open `config.js` and fill in two placeholders:

1. **`mapillaryToken`** — a read-only client token from
   [Mapillary → Developers → Register application](https://www.mapillary.com/dashboard/developers).
   It starts with `MLY|`.
2. **`accounts[0].organizationId`** — the numeric organization ID for BWB South Bay.
   You can find it in the URL of the org's Mapillary dashboard page.

The second account (`ccarfi`) filters by username and needs no ID.

### The token is public on purpose

`config.js` is committed and deployed, and the token is visible to anyone who views
source. That is fine and intentional: it's a **read-only client token** on a static
site with no backend, so there's nowhere to hide it and nothing it can do but read
public imagery. Don't add `config.js` to `.gitignore` — the site won't work without it.

If the token ever needs to be revoked, do it from the Mapillary developer dashboard
and paste a new one here.

## Running locally

Needs a static server (opening `index.html` via `file://` will break the API calls):

```bash
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

Results are cached in `sessionStorage` so reloads during development don't burn
through the rate limit. To force a fresh fetch:

```
http://localhost:8000/?refresh=1
```

## Deploying to GitHub Pages

Everything lives at the repo root and all asset paths are relative, so the site works
from a project subpath (`ccarfi.github.io/moopmapproto/`).

1. Push to `main`.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Branch `main`, folder `/ (root)`. Save.
4. Wait a minute, then load `https://ccarfi.github.io/moopmapproto/`.

## How the data is fetched

Mapillary Graph API v4, `GET https://graph.mapillary.com/images`.

**Both accounts are filtered server-side.** The API documents `creator_username`
("the username who owns and uploaded the image") and `organization_id` as query
parameters on `/images`, and both support pagination via `paging.next` — so there's
no need for the client-side creator filtering fallback. `app.js` still re-checks
`creator.username` on the results as a cheap safety net, in case the server-side
filter is ever silently ignored.

**The bbox is split into tiles.** The API caps a `bbox` query at *less than 0.01
square degrees*. The configured Morgan Hill / Gilroy box is ~0.075 sq deg, roughly
7.5× over the limit, so `app.js` splits it into a grid of `bboxTileDegrees`-sized
tiles (default `0.09°`, i.e. 0.0081 sq deg), queries each, and merges the results
de-duped by image id. Tiles are fetched `CONFIG.concurrency` at a time.

If Mapillary ever relaxes that limit, set `bboxTileDegrees: 0` to issue a single
request for the whole box.

Other notes:

- Markers use `computed_geometry` (the SfM-corrected position) where available and
  fall back to `geometry`. Images with neither are skipped.
- Each request chain stops after `maxPages` pages and logs a console warning, so a
  runaway result set can't hang the page.
- `captured_at` is epoch milliseconds UTC; the panel renders it in
  `America/Los_Angeles`.

## Basemap

CARTO Positron (`light_all`) — key-free, and quieter than standard OSM raster tiles,
which matters when the whole point is reading coloured dots against it. Attribution
for OpenStreetMap, CARTO and Mapillary is in the map's attribution control.

To switch to standard OSM tiles, change the `L.tileLayer(...)` URL in `app.js` to
`https://tile.openstreetmap.org/{z}/{x}/{y}.png` and drop the CARTO credit.

## Not included

No login, no upload, no editing, no 360°/sequence viewer, no offline support, no
backend, no framework, no bundler. It's a prototype.
