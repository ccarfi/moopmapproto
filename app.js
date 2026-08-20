/* Mapillary Photo Map — Morgan Hill / Gilroy
 *
 * Plain JS, no build step. Depends on Leaflet + Leaflet.markercluster (CDN)
 * and CONFIG from config.js.
 */
(function () {
  "use strict";

  var GRAPH = "https://graph.mapillary.com/images";

  var FIELDS = [
    "id", "computed_geometry", "geometry", "captured_at", "compass_angle",
    "altitude", "camera_type", "make", "model", "is_pano", "sequence",
    "creator", "thumb_1024_url", "thumb_2048_url"
  ].join(",");

  var CACHE_VERSION = "v1";
  var REFRESH = new URLSearchParams(location.search).get("refresh") === "1";

  var map, panelEl, panelBody, currentImageId = null;
  var groups = {};   // account.key -> MarkerClusterGroup
  var counts = {};   // account.key -> number of markers rendered

  /* ---------------------------------------------------------------- utils */

  function el(id) { return document.getElementById(id); }

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  function has(v) { return v !== null && v !== undefined && v !== ""; }

  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36);
  }

  function bboxParam(b) {
    // Mapillary wants west,south,east,north with no spaces.
    return [b.west, b.south, b.east, b.north].join(",");
  }

  // Split a bbox into a grid of tiles at most `size` degrees on a side. The
  // Graph API rejects bbox queries covering 0.01 square degrees or more.
  function tileBbox(b, size) {
    if (!size || size <= 0) { return [b]; }
    var tiles = [];
    for (var w = b.west; w < b.east; w += size) {
      for (var s = b.south; s < b.north; s += size) {
        tiles.push({
          west: w,
          south: s,
          east: Math.min(w + size, b.east),
          north: Math.min(s + size, b.north)
        });
      }
    }
    return tiles;
  }

  // Run `worker` over items with a bounded number in flight.
  function mapLimit(items, limit, worker) {
    return new Promise(function (resolve, reject) {
      var results = new Array(items.length);
      var next = 0, active = 0, done = 0, failed = false;
      if (!items.length) { return resolve(results); }
      function pump() {
        while (active < limit && next < items.length && !failed) {
          (function (i) {
            active++; next++;
            Promise.resolve(worker(items[i], i)).then(function (r) {
              results[i] = r; active--; done++;
              if (done === items.length) { resolve(results); } else { pump(); }
            }, function (err) {
              failed = true; reject(err);
            });
          })(next);
        }
      }
      pump();
    });
  }

  /* ------------------------------------------------------------- fetching */

  function ApiError(message, status, apiError) {
    var e = new Error(message);
    e.status = status;
    e.api = apiError || null;
    return e;
  }

  // Mapillary does NOT use 401 for auth problems. Observed responses:
  //   missing / empty token  -> 500 "Invalid OAuth 2.0 Access Token"
  //   unparseable token      -> 400 "Invalid OAuth access token - Cannot parse access token"
  //   well-formed but bogus  -> 500 "Service temporarily unavailable"  (is_transient: true)
  // That last one is indistinguishable from a real outage, so say so rather
  // than sending future-me off to check Mapillary's status page.
  function explainError(err) {
    var msg = (err && err.message) || String(err);
    var status = err && err.status;
    var suffix = status ? " (HTTP " + status + ")" : "";

    if (status === 401 || status === 403 || /oauth|access token/i.test(msg)) {
      return msg + suffix + " — the Mapillary token is missing, invalid, or expired. " +
        "Check CONFIG.mapillaryToken in config.js.";
    }
    if (/service temporarily unavailable/i.test(msg)) {
      return msg + suffix + ". Mapillary returns this same generic error for a " +
        "well-formed but invalid or revoked token as it does for a real outage — " +
        "check CONFIG.mapillaryToken before assuming Mapillary is down.";
    }
    return msg + suffix;
  }

  function buildUrl(params) {
    var u = new URL(GRAPH);
    u.searchParams.set("access_token", CONFIG.mapillaryToken);
    u.searchParams.set("fields", FIELDS);
    u.searchParams.set("limit", "2000");
    Object.keys(params).forEach(function (k) {
      if (has(params[k])) { u.searchParams.set(k, params[k]); }
    });
    return u.toString();
  }

  async function readError(res) {
    var msg = "HTTP " + res.status + (res.statusText ? " " + res.statusText : "");
    var apiError = null;
    try {
      var body = await res.json();
      if (body && body.error) {
        apiError = body.error;
        if (body.error.message) { msg = body.error.message; }
      } else if (body && body.message) { msg = body.message; }
    } catch (e) { /* non-JSON body; keep the status line */ }
    return ApiError(msg, res.status, apiError);
  }

  // Fetch one query, following paging.next up to CONFIG.maxPages.
  async function fetchPaged(params, state) {
    var url = buildUrl(params);
    var out = [];
    var pages = 0;

    while (url) {
      if (pages >= CONFIG.maxPages) { state.capped = true; break; }
      var res = await fetch(url);
      if (!res.ok) { throw await readError(res); }
      var json = await res.json();
      if (Array.isArray(json.data)) { out = out.concat(json.data); }
      pages++;

      var nextUrl = json.paging && json.paging.next ? json.paging.next : null;
      if (nextUrl) {
        // paging.next does not always carry the token through.
        var nu = new URL(nextUrl);
        if (!nu.searchParams.get("access_token")) {
          nu.searchParams.set("access_token", CONFIG.mapillaryToken);
        }
        nextUrl = nu.toString();
      }
      url = nextUrl;
    }
    return out;
  }

  function cacheKey(account) {
    return "mly:" + CACHE_VERSION + ":" +
      hash(CONFIG.mapillaryToken + "|" + bboxParam(CONFIG.bbox) + "|" + account.key);
  }

  function readCache(account) {
    if (REFRESH) { return null; }
    try {
      var raw = sessionStorage.getItem(cacheKey(account));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeCache(account, images) {
    try {
      sessionStorage.setItem(cacheKey(account), JSON.stringify(images));
    } catch (e) {
      console.warn("[mapillary-map] Could not cache " + account.key +
        " results in sessionStorage (likely over quota).", e);
    }
  }

  // Fetch every image for one account across the tiled bbox, de-duped by id.
  async function fetchAccount(account) {
    var cached = readCache(account);
    if (cached) {
      console.info("[mapillary-map] " + account.key + ": " + cached.length +
        " images from sessionStorage cache (add ?refresh=1 to bypass).");
      return cached;
    }

    var tiles = tileBbox(CONFIG.bbox, CONFIG.bboxTileDegrees);
    var state = { capped: false };

    var pages = await mapLimit(tiles, CONFIG.concurrency || 4, function (tile) {
      var params = { bbox: bboxParam(tile) };
      // creator_username and organization_id are both documented server-side
      // filters on /images, and both paginate.
      if (account.organizationId) { params.organization_id = account.organizationId; }
      if (account.creatorUsername) { params.creator_username = account.creatorUsername; }
      return fetchPaged(params, state);
    });

    if (state.capped) {
      console.warn("[mapillary-map] " + account.key + ": hit the maxPages cap (" +
        CONFIG.maxPages + ") on at least one bbox tile — results may be incomplete. " +
        "Raise CONFIG.maxPages or shrink CONFIG.bboxTileDegrees.");
    }

    // De-dupe: tiles share edges, and belt-and-braces re-check the creator
    // filter client-side in case the server-side one is ever ignored.
    var seen = Object.create(null);
    var images = [];
    pages.forEach(function (batch) {
      batch.forEach(function (img) {
        if (!img || !has(img.id) || seen[img.id]) { return; }
        if (account.creatorUsername &&
            img.creator && has(img.creator.username) &&
            img.creator.username !== account.creatorUsername) { return; }
        seen[img.id] = true;
        images.push(img);
      });
    });

    writeCache(account, images);
    return images;
  }

  /* ------------------------------------------------------------ formatting */

  var DATE_FMT = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short", month: "short", day: "numeric", year: "numeric"
  });
  var TIME_FMT = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric", minute: "2-digit"
  });

  function formatCaptured(ms) {
    var n = typeof ms === "string" ? Number(ms) : ms;
    if (!isNum(n)) { return null; }
    var d = new Date(n);
    if (isNaN(d.getTime())) { return null; }
    return DATE_FMT.format(d) + " · " + TIME_FMT.format(d);
  }

  var CARDINALS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

  function cardinal(deg) {
    var i = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
    return CARDINALS[i];
  }

  function middleTruncate(s, max) {
    if (s.length <= max) { return s; }
    var keep = Math.floor((max - 1) / 2);
    return s.slice(0, keep) + "…" + s.slice(s.length - keep);
  }

  // Prefer the SfM-corrected position; fall back to the raw one.
  function coordsOf(img) {
    var g = (img.computed_geometry && img.computed_geometry.coordinates) ||
            (img.geometry && img.geometry.coordinates);
    if (!g || !isNum(g[0]) || !isNum(g[1])) { return null; }
    return { lon: g[0], lat: g[1] };
  }

  /* ------------------------------------------------------------------- UI */

  function showBanner(text) {
    el("banner-text").textContent = text;
    el("banner").hidden = false;
  }

  function showOverlay(title, text, onRetry) {
    el("overlay-title").textContent = title;
    el("overlay-text").textContent = text;
    var retry = el("overlay-retry");
    retry.hidden = !onRetry;
    retry.onclick = onRetry || null;
    el("overlay").hidden = false;
  }

  function row(label, valueNode) {
    var d = document.createElement("div");
    d.className = "row";
    var k = document.createElement("div");
    k.className = "row-label";
    k.textContent = label;
    var v = document.createElement("div");
    v.className = "row-value";
    if (typeof valueNode === "string") { v.textContent = valueNode; }
    else { v.appendChild(valueNode); }
    d.appendChild(k);
    d.appendChild(v);
    return d;
  }

  function buildPhoto(img) {
    var wrap = document.createElement("div");
    wrap.className = "photo";

    var status = document.createElement("div");
    status.className = "photo-status";
    status.innerHTML = '<span class="spinner"></span>';
    wrap.appendChild(status);

    var src = img.thumb_2048_url || img.thumb_1024_url;
    if (!src) {
      status.textContent = "No photo available for this image.";
      return wrap;
    }

    var image = new Image();
    image.alt = "Mapillary image " + img.id;
    image.decoding = "async";
    var triedFallback = false;

    image.onload = function () { status.remove(); image.classList.add("loaded"); };
    image.onerror = function () {
      if (!triedFallback && img.thumb_1024_url && image.src !== img.thumb_1024_url) {
        triedFallback = true;
        image.src = img.thumb_1024_url;
        return;
      }
      image.remove();
      status.textContent = "Photo could not be loaded.";
    };
    image.src = src;
    wrap.appendChild(image);
    return wrap;
  }

  function buildSequenceRow(seq) {
    var box = document.createElement("div");
    box.className = "seq";

    var code = document.createElement("code");
    code.textContent = middleTruncate(String(seq), 24);
    code.title = String(seq);
    box.appendChild(code);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "Copy";
    btn.onclick = function () {
      var done = function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = "Copy"; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(seq)).then(done, function () {
          btn.textContent = "Failed";
        });
      } else {
        var ta = document.createElement("textarea");
        ta.value = String(seq);
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch (e) { btn.textContent = "Failed"; }
        ta.remove();
      }
    };
    box.appendChild(btn);
    return box;
  }

  function openPanel(img, account) {
    currentImageId = img.id;
    panelBody.textContent = "";

    panelBody.appendChild(buildPhoto(img));

    var badge = document.createElement("span");
    badge.className = "badge";
    badge.style.background = account.color;
    badge.textContent = account.label;
    var badgeWrap = document.createElement("div");
    badgeWrap.className = "badge-wrap";
    badgeWrap.appendChild(badge);
    panelBody.appendChild(badgeWrap);

    var rows = document.createElement("div");
    rows.className = "rows";

    var captured = formatCaptured(img.captured_at);
    if (captured) { rows.appendChild(row("Captured", captured)); }

    var cam = [img.make, img.model].filter(has).join(" ");
    if (img.is_pano) { cam = (cam ? cam + " " : "") + "· 360°"; }
    if (cam.trim()) { rows.appendChild(row("Camera", cam.trim())); }
    if (has(img.camera_type)) { rows.appendChild(row("Camera type", String(img.camera_type))); }

    if (isNum(img.compass_angle)) {
      var deg = Math.round(img.compass_angle);
      rows.appendChild(row("Direction", deg + "° (" + cardinal(img.compass_angle) + ")"));
    }

    var c = coordsOf(img);
    if (c) { rows.appendChild(row("Coordinates", c.lat.toFixed(6) + ", " + c.lon.toFixed(6))); }

    if (isNum(img.altitude)) {
      var ft = img.altitude * 3.28084;
      rows.appendChild(row("Altitude", img.altitude.toFixed(1) + " m (" + ft.toFixed(0) + " ft)"));
    }

    if (has(img.sequence)) { rows.appendChild(row("Sequence", buildSequenceRow(img.sequence))); }

    panelBody.appendChild(rows);

    var link = document.createElement("a");
    link.className = "btn link";
    link.href = "https://www.mapillary.com/app/?pKey=" + encodeURIComponent(img.id) + "&focus=photo";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "View on Mapillary ↗";
    panelBody.appendChild(link);

    panelEl.hidden = false;
    document.body.classList.add("panel-open");
  }

  function closePanel() {
    panelEl.hidden = true;
    panelBody.textContent = "";
    currentImageId = null;
    document.body.classList.remove("panel-open");
  }

  function clusterIcon(color) {
    return function (cluster) {
      var n = cluster.getChildCount();
      var size = n < 10 ? 32 : n < 100 ? 40 : 48;
      return L.divIcon({
        html: '<div class="cluster" style="background:' + color + '"><span>' + n + "</span></div>",
        className: "cluster-wrap",
        iconSize: L.point(size, size)
      });
    };
  }

  function renderAccount(account, images) {
    var group = L.markerClusterGroup({
      iconCreateFunction: clusterIcon(account.color),
      maxClusterRadius: 50,
      showCoverageOnHover: false,
      chunkedLoading: true
    });

    var n = 0;
    images.forEach(function (img) {
      var c = coordsOf(img);
      if (!c) { return; }   // no usable position — skip it
      var marker = L.circleMarker([c.lat, c.lon], {
        radius: 6,
        color: "#ffffff",
        weight: 1.5,
        opacity: 1,
        fillColor: account.color,
        fillOpacity: 0.95,
        // Without this the click also reaches the map, whose handler closes the
        // panel — so the panel would open and shut again in the same click.
        // (L.DomEvent.stopPropagation on the native event does NOT prevent
        // this: Leaflet checks its own `_stopped` flag, which the native
        // stopPropagation never sets.)
        bubblingMouseEvents: false
      });
      marker.on("click", function () {
        if (currentImageId === img.id) { return; }
        openPanel(img, account);
      });
      group.addLayer(marker);
      n++;
    });

    groups[account.key] = group;
    counts[account.key] = n;
    group.addTo(map);
    return n;
  }

  function renderLegend() {
    var rows = el("legend-rows");
    rows.textContent = "";

    CONFIG.accounts.forEach(function (account) {
      if (!groups[account.key]) { return; }

      var label = document.createElement("label");
      label.className = "legend-row";

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.onchange = function () {
        if (cb.checked) { map.addLayer(groups[account.key]); }
        else { map.removeLayer(groups[account.key]); }
      };

      var swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = account.color;

      var name = document.createElement("span");
      name.className = "legend-label";
      name.textContent = account.label;

      var count = document.createElement("span");
      count.className = "legend-count";
      count.textContent = counts[account.key];

      label.appendChild(cb);
      label.appendChild(swatch);
      label.appendChild(name);
      label.appendChild(count);
      rows.appendChild(label);
    });

    el("legend").hidden = false;
  }

  function fitToMarkers() {
    // The map can be laid out before the container reaches its final size (the
    // data load is async, so this runs well after init). Without this, Leaflet
    // fits against a stale size and slams the zoom to maxZoom.
    map.invalidateSize({ animate: false });

    var bounds = null;
    Object.keys(groups).forEach(function (k) {
      var b;
      try { b = groups[k].getBounds(); } catch (e) { return; }   // empty group
      if (!b || !b.isValid()) { return; }
      bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    });
    // maxZoom keeps a one-photo result set from fitting all the way to z20.
    if (bounds && bounds.isValid()) { map.fitBounds(bounds, { padding: [48, 48], maxZoom: 17 }); }
    else { map.setView(CONFIG.defaultCenter, CONFIG.defaultZoom); }
  }

  /* ----------------------------------------------------------------- boot */

  function initMap() {
    map = L.map("map", { zoomControl: true }).setView(CONFIG.defaultCenter, CONFIG.defaultZoom);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20,
      subdomains: "abcd",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
        '&copy; <a href="https://carto.com/attributions">CARTO</a> ' +
        '| Imagery &copy; <a href="https://www.mapillary.com/">Mapillary</a> contributors'
    }).addTo(map);

    map.on("click", closePanel);

    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { map.invalidateSize(); }, 150);
    });
  }

  function tokenLooksUnset() {
    return !CONFIG.mapillaryToken || CONFIG.mapillaryToken.indexOf("PASTE_") !== -1;
  }

  async function load() {
    el("overlay").hidden = true;
    el("banner").hidden = true;
    el("loading").hidden = false;

    Object.keys(groups).forEach(function (k) { map.removeLayer(groups[k]); });
    groups = {};
    counts = {};

    if (tokenLooksUnset()) {
      el("loading").hidden = true;
      showOverlay("No Mapillary token",
        "CONFIG.mapillaryToken in config.js is still a placeholder. Paste a read-only " +
        "Mapillary client token (it starts with \"MLY|\") and reload.");
      return;
    }

    var settled = await Promise.allSettled(CONFIG.accounts.map(fetchAccount));
    el("loading").hidden = true;

    var failures = [];
    var total = 0;

    settled.forEach(function (result, i) {
      var account = CONFIG.accounts[i];
      if (result.status === "fulfilled") {
        total += renderAccount(account, result.value);
      } else {
        console.error("[mapillary-map] " + account.key + " failed:", result.reason);
        failures.push({ account: account, error: result.reason });
      }
    });

    if (failures.length === CONFIG.accounts.length) {
      showOverlay("Couldn't load photos", explainError(failures[0].error), load);
      return;
    }

    if (failures.length) {
      showBanner(failures.map(function (f) { return f.account.label; }).join(", ") +
        " failed to load — " + explainError(failures[0].error) +
        " Showing the other account(s).");
    }

    renderLegend();
    fitToMarkers();

    if (total === 0) {
      showOverlay("No photos found",
        "Both queries succeeded but returned nothing in bbox " + bboxParam(CONFIG.bbox) +
        " (west,south,east,north). The usual causes are a wrong bounding box or a wrong " +
        "organization ID / creator username in config.js.");
    }
  }

  function init() {
    panelEl = el("panel");
    panelBody = el("panel-body");

    el("panel-close").onclick = closePanel;
    el("banner-close").onclick = function () { el("banner").hidden = true; };
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !panelEl.hidden) { closePanel(); }
    });

    initMap();
    load();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
