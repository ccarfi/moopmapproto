/* Configuration for the Mapillary Photo Map.
 *
 * This file is intentionally committed and deployed. The Mapillary token below
 * is a read-only client token on a fully static site — there is nothing to hide
 * it behind, and nothing it can do but read public imagery. See README.md.
 */
/* Chapter areas. Declared once and referenced in two places below, so the map's
 * area of interest and the report form's out-of-area check can never drift
 * apart. Keep them generous — an over-tight box that rejects a legitimate
 * report is worse than one that lets a stray through to human review. */
/* The nine Bay Area counties: Alameda, Contra Costa, Marin, Napa, San
 * Francisco, San Mateo, Santa Clara, Solano, Sonoma.
 *
 * Derived from the union of those counties' own extents (OSM/Nominatim,
 * checked 2026-09-24) — W -123.633, S 36.893, E -121.208, N 38.864 — then
 * rounded outward for margin. The binding corners are Sonoma's coast in the
 * west, Napa's northern tip, Santa Clara's south end below Gilroy and its
 * eastern edge past Mt Hamilton. San Francisco's Farallon Islands sit well
 * inside the western edge. */
const BAY_AREA_BOUNDS = { west: -123.70, south: 36.85, east: -121.15, north: 38.92 };
/* Colorado is one of only two states that are true rectangles: 37°N to 41°N,
 * and 102°03′W to 109°03′W (25° to 32° west of the Washington meridian). So
 * unlike the Bay Area box this is the state, not a generous approximation of
 * it — nothing of a neighbouring state falls inside. Surveyed corners wander a
 * few hundred metres from the nominal lines, which the rounding below covers. */
const COLORADO_BOUNDS = { west: -109.0602, south: 36.9925, east: -102.0416, north: 41.0034 };
const UNITED_KINGDOM_BOUNDS = { west: -8.7, south: 49.8, east: 1.8, north: 60.9 };

const CONFIG = {
  // Read-only Mapillary client token. Starts with "MLY|".
  mapillaryToken: "MLY|38185652681048683|1939dcd6b0775816788bca3a3f9b8935",

  // Fallback area of interest, for an account with no `bounds` of its own.
  // Applied client-side, not as a query parameter — Mapillary rejects a bbox
  // this large (see README). Set to null to map every image an account has,
  // wherever it is.
  bbox: BAY_AREA_BOUNDS,

  // One entry per chapter: its own colour, legend row and Mapillary
  // organization. `key` is also the `bwb_chapter` value recorded with every
  // report submission, so it must stay stable once reports exist.
  //
  // Add a chapter by appending an entry:
  //
  //   { key: "bwb_peninsula", label: "BWB Peninsula",
  //     organizationId: "...", color: "#2E86AB",
  //     center: [37.5, -122.3], zoom: 12, bounds: { ... } }
  //
  // An entry can filter by `creatorUsername` instead of `organizationId` to map
  // one person's uploads rather than an organisation's.
  accounts: [
    {
      key: "bwb_south_bay",
      label: "BWB South Bay",
      organizationId: "1605841191131530",
      color: "#E4572E",
      // Used by report.html's out-of-area check. `center` / `zoom` are also
      // where a per-chapter default map view will read from — including the
      // report form's mini-map, which is what someone pans when geolocation
      // fails. Centred on the middle of the bay rather than on the imagery in
      // South County: the chapter now spans nine counties, and starting a
      // volunteer in Alameda 60 miles from their own street is worse than
      // starting everyone one zoom level out.
      center: [37.8, -122.2],
      zoom: 9,
      bounds: BAY_AREA_BOUNDS
    },
    {
      key: "bwb_colorado",
      label: "BWB Colorado",
      organizationId: "1581190229640795",   // slug: bwbcolorado
      // Checked against the other two under simulated protanopia and
      // deuteranopia, not picked by eye: purple, gold, magenta and brown all
      // collapse into #E4572E or #2E86AB for a red- or green-blind reader.
      // Green and teal survive; this is the green.
      color: "#4C9F70",
      center: [39.0, -105.55],
      zoom: 7,
      bounds: COLORADO_BOUNDS
    },
    {
      key: "bwb_united_kingdom",
      label: "BWB United Kingdom",
      organizationId: "2898722160461721",   // slug: bwbunitedkingdom
      color: "#2E86AB",
      // The whole country, deliberately loose. An over-tight box that rejects a
      // legitimate report is worse than one that lets a stray through to review.
      center: [54.0, -2.5],
      zoom: 6,
      bounds: UNITED_KINGDOM_BOUNDS
    }
  ],

  // "Tell us about MOOP" report form (report.html).
  upload: {
    // Apps Script Web App URL. Deploy apps-script/Code.gs, then paste the
    // /exec URL here. Until you do, report.html says it isn't set up yet
    // rather than failing on submit.
    endpoint: "https://script.google.com/macros/s/AKfycbyaEuBrb-9kzwWIToBCuANwoX0rVg6rKrY1B3n1HFaI9zDsRaDsMpNpf6d9xKanGH-jZw/exec",

    // Sent with every request and checked by the Apps Script. This is NOT
    // security — it ships in client-side JS in a public repo and anyone can
    // read it. It only deters drive-by bots. Real access control arrives with
    // Google auth.
    token: "moopmap-v1",

    // One photo per report. The form records a single device position and
    // applies it to everything in the submission; with two photos taken from
    // different spots that pin is wrong for at least one of them. Splitting
    // them into separate reports is what keeps each position honest.
    maxPhotos: 1,
    maxFileMB: 15,

    // Warn when the device fix is looser than this (metres). A wifi-derived
    // position indoors is routinely 50m+ out, which is too coarse to say which
    // patch of ground a photo shows.
    coarseAccuracyM: 50
  },

  defaultCenter: [37.07, -121.61],
  defaultZoom: 12,

  // Basemaps offered by the switcher, in order. All are key-free.
  //
  // maxNativeZoom is the deepest zoom each service actually has tiles for;
  // Leaflet upscales beyond it rather than showing gaps. These are measured,
  // not guessed: OSM returns HTTP 400 above z19, and USGS imagery (not used
  // here) 404s above z16, which is why Esri is the satellite source.
  //
  // CARTO Positron used to be here as "Light", and was the default. CARTO now
  // requires an API key: the tiles still return HTTP 200 as a normal-sized PNG,
  // but the image itself is stamped "API KEY REQUIRED". Nothing in a status
  // code or a byte count catches that — only looking at it does.
  basemaps: [
    {
      key: "streets",
      label: "Streets",
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      maxNativeZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    },
    {
      key: "satellite",
      label: "Satellite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maxNativeZoom: 21,
      dark: true,        // brightens the marker outlines against imagery
      attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Source: Esri, ' +
        'Maxar, Earthstar Geographics, and the GIS User Community'
    }
  ],

  // Which basemap to start on. Overridden by the last one you picked.
  // A stored preference naming a basemap that no longer exists falls back here.
  defaultBasemap: "streets",

  // The date filter opens on the last N days, ending today. Set to 0 or null to
  // start unfiltered with empty pickers.
  defaultDateRangeDays: 365,

  // Photo dot size. Bigger on touch devices: a 6px radius is a 12px target
  // against Apple's 44px guidance, which is why taps miss on a phone and never
  // on a desktop. Kept well under 44 so a dense street doesn't turn into a blob.
  markerRadius: 6,
  markerRadiusTouch: 10,

  // How far a finger may slide between touch-down and touch-up while still
  // counting as a tap. Leaflet's default is 3px, which a thumb beats easily —
  // and past it Leaflet calls the gesture a drag and swallows the click
  // entirely, so the photo silently fails to open.
  tapSlopTouch: 12,

  // Deepest zoom the map allows, across all basemaps.
  maxZoom: 20,

  // Max pages of results to follow per account before giving up.
  maxPages: 20
};
