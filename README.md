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

Mapillary Graph API v4, `GET https://graph.mapillary.com/images` — one request
per account, no bbox in the query.

**Both accounts are filtered server-side.** The API documents `creator_username`
("the username who owns and uploaded the image") and `organization_id` as query
parameters on `/images`, and both work on their own with no bbox. Each returns
its whole set in a single page, so there's no need for the client-side creator
filtering fallback. `app.js` still re-checks `creator.username` on the results
as a cheap safety net, in case the server-side filter is ever silently ignored.

**The bbox is applied client-side, not in the query.** Mapillary rejects a large
bbox two different ways, and the Morgan Hill / Gilroy box trips both:

- Over 0.01 square degrees it fails outright — *"Bounding box area is too large.
  Maximum allowed area is 0.010 square degrees, but got 0.075 square degrees."*
- Well before that limit it also fails on data volume — *"Please reduce the
  amount of data you're asking for"* — which depends on how much imagery the box
  contains, from anyone, not just you. Around Morgan Hill this starts failing at
  about 0.05° on a side and only clears reliably around 0.02°, which would take
  roughly 195 tiled requests per account to cover the region.

Filtering by account alone sidesteps both, so `CONFIG.bbox` is used to narrow
the results after they arrive. Set it to `null` to map everything an account
has, wherever it is. The console logs how many images came back and how many
fell outside the box.

Other notes:

- Markers use `computed_geometry` (the SfM-corrected position) where available
  and fall back to `geometry`. Images with neither are skipped.
- `paging.next` is followed if present, stopping after `maxPages` pages with a
  console warning. At current volumes (152 and 206 images) a single page covers
  everything.
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
