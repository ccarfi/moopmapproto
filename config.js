/* Configuration for the Mapillary Photo Map.
 *
 * This file is intentionally committed and deployed. The Mapillary token below
 * is a read-only client token on a fully static site — there is nothing to hide
 * it behind, and nothing it can do but read public imagery. See README.md.
 */
const CONFIG = {
  // Read-only Mapillary client token. Starts with "MLY|".
  mapillaryToken: "MLY|38185652681048683|1939dcd6b0775816788bca3a3f9b8935",

  // Area of interest: Morgan Hill / Gilroy, CA. Applied client-side, not as a
  // query parameter — Mapillary rejects a bbox this large (see README). Set to
  // null to map every image an account has, wherever it is.
  bbox: { west: -121.72, south: 36.95, east: -121.42, north: 37.20 },

  // One entry per account, each its own colour and legend row. Add a BWB
  // chapter by appending another entry with its organization ID:
  //
  //   { key: "peninsula", label: "BWB Peninsula",
  //     organizationId: "...", color: "#2E86AB" }
  //
  // An entry can filter by `creatorUsername` instead of `organizationId` to map
  // one person's uploads rather than an organisation's.
  accounts: [
    {
      key: "bwb",
      label: "BWB South Bay",
      organizationId: "1605841191131530",
      color: "#E4572E"
    }
  ],

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

  // Deepest zoom the map allows, across all basemaps.
  maxZoom: 20,

  // Max pages of results to follow per account before giving up.
  maxPages: 20
};
