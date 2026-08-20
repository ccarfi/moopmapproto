/* Configuration for the Mapillary Photo Map.
 *
 * This file is intentionally committed and deployed. The Mapillary token below
 * is a read-only client token on a fully static site — there is nothing to hide
 * it behind, and nothing it can do but read public imagery. See README.md.
 */
const CONFIG = {
  // Read-only Mapillary client token. Starts with "MLY|".
  mapillaryToken: "MLY|38185652681048683|1939dcd6b0775816788bca3a3f9b8935",

  // Search area: Morgan Hill / Gilroy, CA.
  bbox: { west: -121.72, south: 36.95, east: -121.42, north: 37.20 },

  accounts: [
    {
      key: "bwb",
      label: "BWB South Bay",
      organizationId: "1605841191131530",
      color: "#E4572E"
    },
    {
      key: "personal",
      label: "ccarfi",
      creatorUsername: "ccarfi",
      color: "#2E86AB"
    }
  ],

  defaultCenter: [37.07, -121.61],
  defaultZoom: 12,

  // Max pages of results to follow per request chain before giving up.
  maxPages: 20,

  // The Graph API documents a hard limit: a bbox query must cover less than
  // 0.01 square degrees. The bbox above is ~0.075 sq deg, so app.js splits it
  // into a grid of tiles this many degrees on a side (0.09 x 0.09 = 0.0081 sq
  // deg, safely under the cap) and merges the results, de-duped by image id.
  // Set to 0 or null to disable tiling and issue one request for the whole bbox.
  bboxTileDegrees: 0.09,

  // How many tile requests to have in flight at once.
  concurrency: 4
};
