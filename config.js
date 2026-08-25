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
const SOUTH_BAY_BOUNDS = { west: -121.72, south: 36.95, east: -121.42, north: 37.20 };

const CONFIG = {
  // Read-only Mapillary client token. Starts with "MLY|".
  mapillaryToken: "MLY|38185652681048683|1939dcd6b0775816788bca3a3f9b8935",

  // Area of interest: Morgan Hill / Gilroy, CA. Applied client-side, not as a
  // query parameter — Mapillary rejects a bbox this large (see README). Set to
  // null to map every image an account has, wherever it is.
  bbox: SOUTH_BAY_BOUNDS,

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
      // where a per-chapter default map view will read from.
      center: [37.07, -121.61],
      zoom: 12,
      bounds: SOUTH_BAY_BOUNDS
    }
  ],

  // "Tell us about MOOP" report form (report.html).
  upload: {
    // Apps Script Web App URL. Deploy apps-script/Code.gs, then paste the
    // /exec URL here. Until you do, report.html says it isn't set up yet
    // rather than failing on submit.
    endpoint: "PASTE_APPS_SCRIPT_EXEC_URL_HERE",

    // Sent with every request and checked by the Apps Script. This is NOT
    // security — it ships in client-side JS in a public repo and anyone can
    // read it. It only deters drive-by bots. Real access control arrives with
    // Google auth.
    token: "moopmap-v1",

    maxPhotos: 10,
    maxFileMB: 15
  },

  defaultCenter: [37.07, -121.61],
  defaultZoom: 12,

  // Basemaps offered by the switcher, in order. All are key-free.
  //
  // maxNativeZoom is the deepest zoom each service actually has tiles for;
  // Leaflet upscales beyond it rather than showing gaps. These are measured,
  // not guessed: OSM returns HTTP 400 above z19, and USGS imagery (not used
  // here) 404s above z16, which is why Esri is the satellite source.
  basemaps: [
    {
      key: "light",
      label: "Light",
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      subdomains: "abcd",
      maxNativeZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
        'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
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
  defaultBasemap: "light",

  // The date filter opens on the last N days, ending today. Set to 0 or null to
  // start unfiltered with empty pickers.
  defaultDateRangeDays: 365,

  // Deepest zoom the map allows, across all basemaps.
  maxZoom: 20,

  // Max pages of results to follow per account before giving up.
  maxPages: 20
};
