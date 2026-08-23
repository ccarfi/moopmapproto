# Mapillary Photo Map — Morgan Hill / Gilroy

A single-page map of [Mapillary](https://www.mapillary.com/) photo uploads around
Morgan Hill and Gilroy, CA, currently showing BWB South Bay. Points are
colour-coded by account, one legend row each, so further BWB chapters can be
added alongside; clicking a point opens a panel with the photo and its metadata.

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

Open `config.js` and fill in the placeholders:

1. **`mapillaryToken`** — a read-only client token from
   [Mapillary → Developers → Register application](https://www.mapillary.com/dashboard/developers).
   It starts with `MLY|`.
2. **`accounts[].organizationId`** — the numeric organization ID, read from the
   URL of the org's Mapillary dashboard page.

### Adding a chapter

`CONFIG.accounts` is a list, one entry per legend row, each with its own colour.
To map another BWB chapter alongside South Bay, append an entry:

```js
{ key: "peninsula", label: "BWB Peninsula", organizationId: "…", color: "#2E86AB" }
```

Everything downstream — the fetch, the legend row, the per-account cluster group
and its toggle, the panel badge — is driven off that list, so nothing else needs
touching. An entry can carry `creatorUsername` instead of `organizationId` to map
one person's uploads rather than an organisation's.

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

**Accounts are filtered server-side.** The API documents `organization_id` and
`creator_username` ("the username who owns and uploaded the image") as query
parameters on `/images`, and both work on their own with no bbox, each returning
its whole set in a single page. `app.js` still re-checks `creator.username` on
the results as a cheap safety net, for entries that filter by creator, in case
the server-side filter is ever silently ignored.

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

**Full screen.** The sidebar photo has a full-screen button (and the photo
itself is tappable). It opens with the `thumb_2048` image already on screen, so
it appears instantly, then upgrades to `thumb_original` — 4032px wide on an
iPhone capture — once that downloads. Tapping the photo toggles between fit-to-
screen and actual pixels, with panning; Escape, the x, or a backdrop click
closes it. Escape closes the photo first and the detail panel second.

The zoom matters most on a phone: a landscape photo fitted to a portrait screen
renders about 343px wide, narrower than the 375px sidebar it came from, so
without zoom "full screen" would show *less* detail than the thumbnail.

Other notes:

- Markers use `computed_geometry` (the SfM-corrected position) where available
  and fall back to `geometry`. Images with neither are skipped.
- `paging.next` is followed if present, stopping after `maxPages` pages with a
  console warning. At current volumes (152 and 206 images) a single page covers
  everything.
- `captured_at` is epoch milliseconds UTC; the panel renders it in
  `America/Los_Angeles`.

## Collapsing the controls

The legend card collapses to a small pill in the corner. It starts collapsed on
phones (under 768px) and expanded on wider screens; the choice is remembered in
`localStorage` and overrides that default.

The pill keeps the count visible — `234`, or `42 of 234` when the date filter is
excluding something. That matters because the filter is active on load, so the
collapsed state has to be able to say the map is showing a subset.

## Date filter

The legend has a from/to date filter, inclusive on both ends. It opens on the
last `CONFIG.defaultDateRangeDays` days ending today (365 by default) with both
pickers populated, rather than showing an empty `mm/dd/yyyy`. **Amounts to the
map being filtered on load** — which is honest, since the pickers state the
range being shown. Set `defaultDateRangeDays` to 0 to start unfiltered with
empty pickers instead; either side can also be cleared by hand for an open-ended
range.

**Reset** restores the default window. It appears only once the range differs
from that default.

Legend counts read `82 of 234` when the filter is actually excluding something,
and plain `234` when it isn't — so the default window doesn't render a
pointless `234 of 234`. The note under the pickers always reports the span of
dates the data actually covers, which is what explains a small count over a wide
default range. Picker bounds span both the data and the default window, since
otherwise the browser flags the defaulted values as out of range.

Dates are compared as `YYYY-MM-DD` calendar strings in `America/Los_Angeles`,
not as timestamps. That makes "inclusive" exact, avoids DST arithmetic entirely,
and matches the Pacific dates the detail panel shows — a photo the panel calls
"Sun, Aug 23" is one an 08-23 filter includes.

A range with no photos in it reports that in the legend rather than firing the
full-screen empty state, which is reserved for "your bbox or org ID is wrong".
Images with no `captured_at` are hidden while a filter is active, since they
can't be shown to fall inside it; the legend notes how many.

Filtering rebuilds each account's cluster group from the markers that match, so
it composes with the account toggles — hiding and re-showing an account while
filtered restores the filtered set, not everything.

## Basemaps

A switcher in the legend card offers three key-free layers. Your choice is
remembered in `localStorage`.

| Layer | Source | Tiles to |
| --- | --- | --- |
| **Light** (default) | CARTO Positron | z20 |
| **Streets** | OpenStreetMap standard | z19 |
| **Satellite** | Esri World Imagery | z21 |

Light is the default because coloured dots read most easily against it.
Satellite thickens the marker outlines (`.basemap-dark` in `styles.css`) so they
stay legible over aerial imagery.

Each layer carries its own attribution, which swaps with the layer; the
Mapillary credit is pinned separately so it shows on all of them.

**On `maxNativeZoom`.** The map goes to z20, but the services don't all have
tiles that deep — OSM returns HTTP 400 above z19. Each layer declares the
deepest zoom it actually has, and Leaflet upscales beyond that instead of
leaving gaps. Add a layer without it and the top zoom levels break.

**On the satellite source.** Esri World Imagery is key-free and used widely, but
it is Esri's service under Esri's terms, not an open licence. The public-domain
alternative is USGS (`https://basemap.nationalmap.gov/arcgis/rest/services/
USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`), which 404s above z16 — usable with
`maxNativeZoom: 16`, but visibly soft at the zooms where you're inspecting a
photo location. Swap it in `CONFIG.basemaps` if you'd rather have the clean
licence.

To add a layer, append to `CONFIG.basemaps` with a `key`, `label`, `url`,
`attribution` and `maxNativeZoom`. Set `dark: true` for imagery.

## Not included

No login, no upload, no editing, no 360°/sequence viewer, no offline support, no
backend, no framework, no bundler. It's a prototype.
