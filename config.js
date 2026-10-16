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
/* South Bay, the Peninsula and the inner East Bay — clipped at Berkeley.
 *
 * This was the nine Bay Area counties until 2026-10-14, derived from the union
 * of their extents (OSM/Nominatim, 2026-09-24): W -123.633, S 36.893,
 * E -121.208, N 38.864, rounded outward. That rectangle reached far past
 * anywhere this chapter works, and the reason is worth keeping: its north came
 * from Napa's tip in the far north-west and its east from Santa Clara past Mt
 * Hamilton in the south-east, so its NORTH-EAST corner was simply where those
 * two lines crossed — in Placer County, about 150 km from any Bay Area county.
 * It swallowed Sacramento, Roseville and Folsom, which meant a volunteer there
 * who picked this chapter by mistake passed the out-of-area check.
 *
 * The north edge is now Berkeley's northern city limit (37.9067, OSM, checked
 * 2026-10-14) rounded outward. Marin above Mill Valley, Sonoma, Napa, Solano
 * and most of Contra Costa — Richmond, Concord, Martinez, Antioch — are
 * outside it now, deliberately. No report ever filed is affected: the
 * northernmost of 33 is Mountain View at 37.386, 58 km clear of the line.
 *
 * Walnut Creek lands 11 m outside, which is an accident of where its centroid
 * falls rather than a decision. Recorded so it reads as known.
 *
 * West, south and east are unchanged and still carry the old county union, so
 * the Farallon Islands and Gilroy stay comfortably inside. */
const SOUTH_BAY_BOUNDS = { west: -123.70, south: 36.85, east: -121.15, north: 37.91 };
/* Colorado is one of only two states that are true rectangles: 37°N to 41°N,
 * and 102°03′W to 109°03′W (25° to 32° west of the Washington meridian). So
 * unlike the Bay Area box this is the state, not a generous approximation of
 * it — nothing of a neighbouring state falls inside. Surveyed corners wander a
 * few hundred metres from the nominal lines, which the rounding below covers. */
const COLORADO_BOUNDS = { west: -109.0602, south: 36.9925, east: -102.0416, north: 41.0034 };
/* The Sacramento Valley and the Sierra foothills, read off the extent given in
 * #49 — a map view rather than a drawn rectangle, so the corners were solved
 * for by fitting the projection to two labelled cities and then checked
 * against five more. Maxwell, Lodi, Fairfield, Woodland and Placerville all
 * landed within 9 px, and the latitude/longitude pixel ratio matched what
 * Mercator predicts at 38.6N, so the fit is the picture's and not a guess.
 *
 * Measured W -122.286, E -120.580, S 38.123, N 39.334, rounded outward.
 * Colusa and Yuba City in the north, Lodi in the south, Napa's eastern edge in
 * the west, Placerville and Georgetown in the foothills.
 *
 * Its southern edge is 38.05 and South Bay's northern edge is 37.91, so the
 * two no longer overlap. They did until 2026-10-14 — see SOUTH_BAY_BOUNDS. */
const SACRAMENTO_BOUNDS = { west: -122.35, south: 38.05, east: -120.50, north: 39.40 };
/* The Coyote Creek watershed, PROVISIONAL.
 *
 * Fitted from a screenshot KCCB sent — their own map could not be shared
 * outside their organization. The projection was solved from two labelled
 * cities and checked against five more; Milpitas and Mt Hamilton landed within
 * about 15 px, so the fit is sound even where reading the boundary off a
 * picture is not. Measured W -121.93, E -121.38, S 37.01, N 37.48, rounded
 * outward.
 *
 * REPLACE THIS when KCCB send their KML (#57). The watershed is a long
 * diagonal strip with a large eastern lobe toward Mt Hamilton, so this
 * rectangle is several times its area and includes downtown San Jose, which is
 * not in the watershed at all — the boundary runs through east San Jose. That
 * costs little today, because bounds only drive a soft warning and a
 * pre-upload gate, but it is wrong and it is meant to be temporary. The
 * arrival of that file is the trigger for #53, or this comment will still be
 * here in a year.
 *
 * Entirely inside SOUTH_BAY_BOUNDS, which is correct and not fixable by any
 * rectangle: Coyote Creek runs through San Jose and both groups work the same
 * ground. The per-organization link (#50) is what keeps them apart. */
const COYOTE_CREEK_BOUNDS = { west: -121.95, south: 36.98, east: -121.35, north: 37.50 };
const UNITED_KINGDOM_BOUNDS = { west: -8.7, south: 49.8, east: 1.8, north: 60.9 };
/* The European Netherlands, rounded outward from its own extent
 * (OSM/Nominatim "Europees Nederland", checked 2026-10-07) —
 * S 50.7504, N 53.7488, W 3.0808, E 7.2275. The binding corners are the
 * Zeeland coast in the west, Vaals at the southern tip, the Wadden islands in
 * the north and the Twente border in the east.
 *
 * Europe only. Nominatim's "Nederland" also covers Bonaire, Saba and Sint
 * Eustatius, which would stretch this box 74° west across the Atlantic and
 * leave the out-of-area check meaning nothing — a pin dropped anywhere in the
 * Caribbean, or most of the ocean between, would pass. A chapter named for
 * Amsterdam does not need them.
 *
 * This rectangle leaks more than the others do, and knowingly: Brussels,
 * Antwerp and Dusseldorf all sit inside it, because northern Belgium and the
 * western Rhineland share the Netherlands' latitudes and longitudes. No
 * axis-aligned box can exclude them. Per the rule above that is the right way
 * round — a stray reaches human review, whereas an over-tight box silently
 * rejects a volunteer standing in Maastricht. Worth knowing when a pin looks
 * odd rather than wondering why the check passed. */
const NETHERLANDS_BOUNDS = { west: 3.0, south: 50.70, east: 7.30, north: 53.80 };

const CONFIG = {
  // Read-only Mapillary client token. Starts with "MLY|".
  mapillaryToken: "MLY|38185652681048683|1939dcd6b0775816788bca3a3f9b8935",

  // Fallback area of interest, for an account with no `bounds` of its own.
  // Applied client-side, not as a query parameter — Mapillary rejects a bbox
  // this large (see README). Set to null to map every image an account has,
  // wherever it is.
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
      // where a per-chapter default map view will read from — including the
      // report form's mini-map, which is what someone pans when geolocation
      // fails. Centred on the middle of the bay rather than on the imagery in
      // South County: the chapter now spans nine counties, and starting a
      // volunteer in Alameda 60 miles from their own street is worse than
      // starting everyone one zoom level out.
      center: [37.8, -122.2],
      zoom: 9,
      bounds: SOUTH_BAY_BOUNDS
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
    },
    {
      key: "bwb_amsterdam",
      label: "BWB Amsterdam",
      organizationId: "1467065178686426",   // slug: bwbamsterdam
      // Brown, picked by simulating protanopia and deuteranopia against the
      // three colours above rather than by eye. It is the only candidate that
      // stays clearly apart from all of them under both — the obvious choices,
      // purple and magenta, collapse towards this map's blue for a deuteranope
      // — and at 9.3:1 against white it is also the most legible behind a
      // cluster count, where the others sit at a marginal 3.2 to 4.1.
      color: "#5D4037",
      // The whole country, not just the city: the chapter is named for
      // Amsterdam but the box is what decides whether a report is in area, and
      // a volunteer cleaning in Rotterdam or Utrecht is plainly doing BWB
      // Amsterdam's work.
      center: [52.2, 5.3],
      zoom: 7,
      bounds: NETHERLANDS_BOUNDS
    },
    {
      key: "bwb_sacramento",
      label: "BWB Sacramento",
      organizationId: "2304511726980904",   // slug: bwbsacramento
      // Deep violet, picked the same way as the others: simulate protanopia
      // and deuteranopia against every colour already in use and take the
      // candidate that stays furthest from all of them. A fifth is harder than
      // a fourth, but this one is not close — 42.1 worst case against 27.2 for
      // the brown above, and 9.2:1 against white for the cluster counts.
      color: "#512DA8",
      center: [38.7, -121.4],
      zoom: 8,
      bounds: SACRAMENTO_BOUNDS
    },
    {
      key: "kccb",
      label: "Keep Coyote Creek Beautiful",
      organizationId: "2898761457173484",   // slug: kccbv1, display name "KCCB"
      // Deep blue. The palette is at its limit — no sixth colour clears dE 20
      // against all five above, and the tightest pair already on the map is
      // 21.4 — so this was chosen by the distance that actually has to hold
      // rather than by the average.
      //
      // KCCB sits inside BWB South Bay, so its dots are interleaved with
      // orange ones and with nothing else; Sacramento is 150 km north. Against
      // #E4572E this scores 82.5, which is the number that matters on the map.
      // Its nearest rival is Sacramento's violet at 18.5, and those two only
      // ever meet in the legend, where each swatch has a name beside it.
      color: "#01579B",
      center: [37.24, -121.65],
      zoom: 9,
      bounds: COYOTE_CREEK_BOUNDS
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

    // Whether a volunteer may place or drag the pin themselves.
    //
    // OFF after field testing: a hand-placed location ended in confusion or
    // error often enough that the affordance cost more than it gave. Two
    // photos went in 99 km and 107 km from where they were taken, and the
    // guardrails built afterwards made the flow harder to explain without
    // making the pins much more trustworthy.
    //
    // The capability is untouched — the click handler, the drag handler, the
    // zoom gate and the device cross-check are all still here and still work.
    // Setting this to true restores the affordances exactly as they were.
    allowManualPlacement: false,

    // Below this zoom, tapping the map does not place a pin.
    //
    // A tap is only ever as precise as the zoom allows. At z9 a thumb covers
    // about 4.9 km, so a pin placed there carries no information at all — yet
    // it gets stored to six decimal places and reads as authoritative. At z15
    // a thumb is about 76 m, comparable to the device fixes these reports
    // actually get (5-40 m).
    //
    // Too strict is its own failure: someone with no GPS who cannot place a
    // pin cannot report at all, which is worse than a rough one.
    minPlacementZoom: 15,

    // How far a hand-placed pin may sit from the device's own fix before the
    // form asks which one is right. Generous on purpose: nudging a pin to the
    // correct side of a path must never trigger it, and the error worth
    // catching was 99 km. Even a coarse cell-tower fix settles that.
    disagreeKm: 1,

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
