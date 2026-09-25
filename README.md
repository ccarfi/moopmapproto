# MOOP Map — **[moopmap.org](https://moopmap.org)**

A single-page map of [Mapillary](https://www.mapillary.com/) photo uploads by
Burners Without Borders chapters. Points are colour-coded by chapter, one legend
row each; clicking a point opens a panel with the photo and its metadata.

| Chapter | Mapillary org | Area |
| --- | --- | --- |
| BWB South Bay | `1605841191131530` (`bwbsouthbay`) | The nine Bay Area counties, CA |
| BWB Colorado | `1581190229640795` (`bwbcolorado`) | the state of Colorado |
| BWB United Kingdom | `2898722160461721` (`bwbunitedkingdom`) | whole of the UK |

Plain HTML/CSS/JS with Leaflet from a CDN. **No build step** — what's committed is
what GitHub Pages serves.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Entry point. Loads Leaflet + markercluster from unpkg, then `config.js` and `app.js`. |
| `config.js` | Everything you'd want to change: token, bbox, accounts, colours. |
| `app.js` | Fetching, map, legend, detail panel. |
| `report.html` / `report.js` | "Tell us about MOOP" photo submission form. |
| `apps-script/Code.gs` | Server side of the form — paste into a Google Apps Script Web App. |
| `RUNBOOK.md` | Getting submitted photos from Drive into Mapillary. |
| `ADDING-A-CHAPTER.md` | Onboarding a new BWB chapter — Mapillary org, config, Apps Script. |
| `HOW-TO-REPORT.md` | One-page guide for volunteers. |
| `tools/build_desc.py` | Builds the upload description file from the Sheet, and gates the batch. |
| `tools/mly_upload.py` | Wrapper around `mapillary_tools`, which crashes mid-upload without it. |
| `styles.css` | All styling. |

## Setup

Open `config.js` and fill in the placeholders:

1. **`mapillaryToken`** — a read-only client token from
   [Mapillary → Developers → Register application](https://www.mapillary.com/dashboard/developers).
   It starts with `MLY|`.
2. **`accounts[].organizationId`** — the numeric organization ID, read from the
   URL of the org's Mapillary dashboard page.

### Adding a chapter

`CONFIG.accounts` is the chapter list — one entry per legend row, each with its own
colour. (The legend calls this section **Chapters**; the config key is still
`accounts` internally.)
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

Then visit <http://localhost:8000>. Serving locally rather than opening
`index.html` directly matters: `file://` breaks the API calls, and geolocation
on the report form needs `localhost` or HTTPS.

Results are cached in `sessionStorage` so reloads during development don't burn
through the rate limit. To force a fresh fetch:

```
http://localhost:8000/?refresh=1
```

## Deploying

Served by GitHub Pages from `main` at the repo root, on the custom domain
**[moopmap.org](https://moopmap.org)**. Push to `main` and it redeploys in about
a minute.

| URL | |
| --- | --- |
| `https://moopmap.org` | canonical |
| `https://www.moopmap.org` | redirects to the apex |
| `https://ccarfi.github.io/moopmapproto/` | the old project URL, also redirects |

Pages settings are **Source: Deploy from a branch**, branch `main`, folder
`/ (root)`, with **Custom domain** set to `moopmap.org` and **Enforce HTTPS**
ticked. The `CNAME` file in the repo root is what carries the domain; GitHub
writes it when you save the custom domain, so leave it alone.

DNS at the registrar: four `A` records on `@` pointing at `185.199.108.153`,
`.109.153`, `.110.153` and `.111.153`, plus a `CNAME` on `www` to
`ccarfi.github.io`.

**All asset paths are relative**, which is why moving from the project subpath to
the domain root needed no code changes. Keep it that way — a leading slash works
at the root but would have broken the old URL, and would break any future move.

**HTTPS is not optional here.** `navigator.geolocation` only works on a secure
origin, and the report form requires a location, so on plain HTTP the form
cannot be completed at all.

### Checking a deploy

`/pages` reports a **stale status** — it showed `errored` for a build that had
already been superseded by a successful one seconds later. Ask for the latest
build instead:

```bash
gh api repos/ccarfi/moopmapproto/pages/builds/latest --jq '{status,commit:.commit[0:7]}'
```

## How the data is fetched

Mapillary Graph API v4, `GET https://graph.mapillary.com/images` — one request
per account, no bbox in the query.

**Chapters are filtered server-side.** The API documents `organization_id` and
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

## Reporting MOOP

`report.html` lets a volunteer send photos from their phone without installing
or learning Mapillary. It posts to a Google Apps Script Web App, which files the
photo in Drive and logs a row in a Sheet; `RUNBOOK.md` covers the batch upload
to Mapillary from there. Once uploaded, photos appear on the map with **no code
change** — they arrive through the same `organization_id` query that already
drives it.

### Setting it up

1. Create a Drive folder (e.g. "MoopMap Uploads") and a Google Sheet.
2. [script.google.com](https://script.google.com) → new project → paste in
   `apps-script/Code.gs`.
3. Fill in `ROOT_FOLDER_ID` and `SHEET_ID` at the top of that file.
4. Deploy → New deployment → **Web app**, executing as *you*, access *Anyone*.
5. Paste the `/exec` URL into `CONFIG.upload.endpoint` in `config.js`.

Until step 5, the form says it isn't set up yet rather than failing on submit.

**Re-deploy a new version after every edit to `Code.gs`.** The `/exec` URL keeps
serving the previous version until you do — it's the most common reason a change
appears not to take effect.

### Things that are load-bearing

- **The chapter picker sets `bwb_chapter`,** which decides the Mapillary
  organization a photo is eventually uploaded under. `CONFIG.accounts[].key` is
  the value recorded, so those keys must stay stable once reports exist.
- **Photos are never re-encoded.** No canvas, no resizing — drawing an image to
  a canvas strips EXIF, and EXIF is where the photo's GPS and capture time live.
  The raw `File` bytes are sent as-is.
- **The device position is the only source, not a fallback.** iOS strips EXIF
  from every photo picked through a file input — always, both Safari and Brave,
  confirmed across seven real submissions. A 140-byte stub survives with
  orientation and pixel dimensions; no GPS, no capture time. So a report with no
  position can never be placed, and the form refuses to send one.
- **Location is required, with a manual escape hatch.** Tapping the map places
  the pin by hand, which covers a blocked or failing GPS. Brave denies
  geolocation without prompting and without erroring, so there is a 20s watchdog
  and Brave-specific wording — "allow location" is useless advice there.
- **A coarse fix is flagged.** Above `CONFIG.upload.coarseAccuracyM` (50 m) the
  form says so; indoor wifi positioning is routinely 50 m+ out, too coarse to
  identify a patch of ground.
- **Requests are `text/plain`.** Apps Script Web Apps redirect in a way that
  fails CORS preflight, so a `text/plain` body — a "simple request" — is what
  makes this work at all. Sending `application/json` will not.
- **One photo per report.** The form captures a single device position and
  applies it to the submission, so two photos taken from different spots would
  share a pin that is wrong for at least one. Separate reports keep each
  position honest. Enforced client-side and in `Code.gs`, and the position is
  cleared and re-read after each send so a stale pin can't carry over.
- **`CONFIG.upload.token` is not security.** It ships in client-side JS in a
  public repo. It deters drive-by bots; the endpoint is open by design until
  Google auth lands.

### Out-of-area check

Each chapter has a `bounds` box. If the submitted position falls outside the
selected chapter's box, the form warns but still lets it through — a bad bounds
guess shouldn't be able to block a legitimate report. The **hard** gate is in
`RUNBOOK.md`, before upload, where a mistake is still cheap to fix.

`BAY_AREA_BOUNDS` in `config.js` is one object referenced by both `CONFIG.bbox`
and the chapter's `bounds`, so the map's area of interest and the form's check
cannot drift apart.

## More than one chapter

Each chapter filters against **its own** `bounds`, not a single global box.
`CONFIG.bbox` survives only as a fallback for an entry that declares none.

Chapters can be thousands of miles apart, so there is no useful "fit everything"
view — framing South Bay and a UK chapter together shows the Atlantic. The map
therefore focuses **one chapter at a time**:

- Every chapter's markers are on the map; only the view is scoped.
- Clicking a chapter name in the legend flies to it, and that choice is
  remembered in `localStorage`.
- On load it returns to the chapter you last looked at, falling back to the
  first one that has photos. A chapter with no photos yet falls back to its
  declared `center` / `zoom`, so a newly added chapter still goes somewhere
  sensible.

The legend checkbox and the chapter name are separate controls: the checkbox
shows or hides that chapter's markers, the name moves the view.

## Collapsing the controls

The legend card collapses to a small pill in the corner. It starts collapsed on
phones (under 768px) and expanded on wider screens; the choice is remembered in
`localStorage` and overrides that default.

Collapsed, the pill is just the icon and a chevron — no count. Counts live on
the chapter rows, labelled (`234 images`, or `42 of 234 images` while the date
filter is excluding something), because an unlabelled number reads as noise.

The tradeoff: a collapsed panel gives no hint that the date filter is narrowing
what's on the map. That's tolerable because the default range covers everything,
so the only way to be filtered *and* collapsed is to have narrowed it yourself.

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

A switcher in the legend card offers two key-free layers. Your choice is
remembered in `localStorage`.

| Layer | Source | Tiles to |
| --- | --- | --- |
| **Streets** (default) | OpenStreetMap standard | z19 |
| **Satellite** | Esri World Imagery | z21 |

Satellite thickens the marker outlines (`.basemap-dark` in `styles.css`) so they
stay legible over aerial imagery.

**CARTO Positron was removed.** It shipped as "Light" and was the default until
CARTO started requiring an API key. The failure mode is worth remembering: the
tiles still return **HTTP 200 with a normal-sized PNG**, but the image itself is
stamped "API KEY REQUIRED". No status code, content type or byte count reveals
that — only rendering it does, which is why the first check of this said CARTO
was fine. A stored `moopmap:basemap` preference naming `light` falls back to the
default, so nobody is stranded on a layer that no longer exists.

The report form's mini-map used the same CARTO tiles and was switched to OSM at
the same time.

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
