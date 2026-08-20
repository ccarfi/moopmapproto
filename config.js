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

  // Max pages of results to follow per account before giving up.
  maxPages: 20
};
