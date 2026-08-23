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
    "creator", "thumb_1024_url", "thumb_2048_url", "thumb_original_url"
  ].join(",");

  var CACHE_VERSION = "v3";
  var REFRESH = new URLSearchParams(location.search).get("refresh") === "1";

  var map, panelEl, panelBody, currentImageId = null;
  var lightboxImageId = null, lightboxReturnFocus = null;
  var basemapLayers = {};   // basemap.key -> TileLayer
  var currentBasemap = null;
  var groups = {};        // account.key -> MarkerClusterGroup
  var markersOf = {};     // account.key -> all its markers, filtered or not
  var counts = {};        // account.key -> markers with a usable position
  var shownCounts = {};   // account.key -> markers passing the date filter

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

  // Is this position inside the configured area of interest?
  function inBbox(c) {
    var b = CONFIG.bbox;
    if (!b) { return true; }
    return c.lon >= b.west && c.lon <= b.east && c.lat >= b.south && c.lat <= b.north;
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

  // Fetch every image for one account, then narrow to the configured bbox.
  //
  // Note there is no bbox in the *query*. Mapillary rejects a bbox covering
  // 0.01 square degrees or more outright, and separately refuses any box
  // holding too much imagery ("Please reduce the amount of data you're asking
  // for") — around Morgan Hill that kicks in well before the area cap, so
  // covering this region by tiling would take ~195 requests per account.
  // Filtering by account alone returns the whole set in one request, so the
  // bbox is applied here instead.
  async function fetchAccount(account) {
    var cached = readCache(account);
    if (cached) {
      console.info("[mapillary-map] " + account.key + ": " + cached.length +
        " images from sessionStorage cache (add ?refresh=1 to bypass).");
      return cached;
    }

    var params = {};
    if (account.organizationId) { params.organization_id = account.organizationId; }
    if (account.creatorUsername) { params.creator_username = account.creatorUsername; }

    var state = { capped: false };
    var raw = await fetchPaged(params, state);

    if (state.capped) {
      console.warn("[mapillary-map] " + account.key + ": hit the maxPages cap (" +
        CONFIG.maxPages + ") — results may be incomplete. Raise CONFIG.maxPages.");
    }

    var seen = Object.create(null);
    var images = [];
    var outside = 0, unplaced = 0;

    raw.forEach(function (img) {
      if (!img || !has(img.id) || seen[img.id]) { return; }
      // Belt-and-braces: re-check the creator in case the server-side filter
      // is ever silently ignored.
      if (account.creatorUsername &&
          img.creator && has(img.creator.username) &&
          img.creator.username !== account.creatorUsername) { return; }
      seen[img.id] = true;

      var c = coordsOf(img);
      if (!c) { unplaced++; return; }
      if (!inBbox(c)) { outside++; return; }
      images.push(img);
    });

    console.info("[mapillary-map] " + account.key + ": " + images.length +
      " images in bbox (" + raw.length + " returned by the API" +
      (outside ? ", " + outside + " outside the bbox" : "") +
      (unplaced ? ", " + unplaced + " with no position" : "") + ").");

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

  // The date filter compares calendar dates as YYYY-MM-DD strings rather than
  // timestamps. That makes "inclusive" exact and sidesteps DST entirely, and it
  // matches the Pacific dates the panel already shows.
  var LA_DATE_PARTS = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  });

  function laDate(ms) {
    var n = typeof ms === "string" ? Number(ms) : ms;
    if (!isNum(n)) { return null; }
    var d = new Date(n);
    if (isNaN(d.getTime())) { return null; }
    var p = {};
    LA_DATE_PARTS.formatToParts(d).forEach(function (part) { p[part.type] = part.value; });
    return p.year + "-" + p.month + "-" + p.day;
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

  /* --------------------------------------------------------- full screen */

  // The sidebar shows thumb_2048; full screen starts from that same (already
  // cached, so instant) image and upgrades to thumb_original — 4032px wide on
  // an iPhone capture — once it has downloaded.
  function openLightbox(img) {
    var lb = el("lightbox");
    var lbImg = el("lightbox-img");
    var hint = el("lightbox-hint");

    lightboxReturnFocus = document.activeElement;
    lightboxImageId = img.id;

    var quick = img.thumb_2048_url || img.thumb_1024_url;
    lbImg.src = quick;
    lbImg.alt = "Mapillary image " + img.id;

    var full = img.thumb_original_url;
    if (full && full !== quick) {
      hint.textContent = "Loading full resolution…";
      var hi = new Image();
      hi.onload = function () {
        if (lightboxImageId !== img.id) { return; }   // moved on already
        lbImg.src = full;
        hint.textContent = "Tap the photo to zoom";
        setTimeout(function () {
          if (lightboxImageId === img.id) { hint.textContent = ""; }
        }, 2600);
      };
      hi.onerror = function () {
        if (lightboxImageId === img.id) { hint.textContent = ""; }
      };
      hi.src = full;
    } else {
      hint.textContent = "";
    }

    setZoomed(false);
    lb.hidden = false;
    document.body.classList.add("lightbox-open");
    el("lightbox-close").focus();
  }

  // Fit <-> actual pixels. Centres the scroll on the middle of the photo so
  // zooming in doesn't dump you in the top-left corner.
  function setZoomed(on) {
    var lb = el("lightbox");
    var stage = el("lightbox-stage");
    lb.classList.toggle("zoomed", !!on);
    if (on) {
      stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
      stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
    } else {
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
    }
  }

  // Returns true if it actually closed something, so Escape can fall through
  // to the detail panel when no photo is open.
  function closeLightbox() {
    var lb = el("lightbox");
    if (lb.hidden) { return false; }
    lb.hidden = true;
    lb.classList.remove("zoomed");
    el("lightbox-img").removeAttribute("src");
    el("lightbox-hint").textContent = "";
    lightboxImageId = null;
    document.body.classList.remove("lightbox-open");
    if (lightboxReturnFocus && lightboxReturnFocus.focus) { lightboxReturnFocus.focus(); }
    lightboxReturnFocus = null;
    return true;
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

    var zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "photo-zoom";
    zoom.setAttribute("aria-label", "View full screen");
    zoom.title = "View full screen";
    zoom.hidden = true;
    zoom.innerHTML =
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/>' +
      '<path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    zoom.onclick = function () { openLightbox(img); };

    image.onload = function () {
      status.remove();
      image.classList.add("loaded");
      zoom.hidden = false;      // only offer full screen once there's a photo
    };
    image.onerror = function () {
      if (!triedFallback && img.thumb_1024_url && image.src !== img.thumb_1024_url) {
        triedFallback = true;
        image.src = img.thumb_1024_url;
        return;
      }
      image.remove();
      zoom.remove();
      status.textContent = "Photo could not be loaded.";
    };
    // Tapping the photo itself opens full screen too — a much bigger target
    // than the icon on a phone.
    image.onclick = function () { openLightbox(img); };

    image.src = src;
    wrap.appendChild(image);
    wrap.appendChild(zoom);
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
    closeLightbox();
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
    closeLightbox();
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

    var markers = [];
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
      marker.__date = laDate(img.captured_at);   // null if the image has no timestamp
      markers.push(marker);
    });

    groups[account.key] = group;
    markersOf[account.key] = markers;
    counts[account.key] = markers.length;
    shownCounts[account.key] = markers.length;
    group.addTo(map);           // applyDateFilter fills it
    return markers.length;
  }

  /* --------------------------------------------------------------- basemaps */

  var BASEMAP_PREF = "moopmap:basemap";

  function readBasemapPref() {
    try { return localStorage.getItem(BASEMAP_PREF); } catch (e) { return null; }
  }

  function writeBasemapPref(key) {
    try { localStorage.setItem(BASEMAP_PREF, key); } catch (e) { /* private mode */ }
  }

  function basemapByKey(key) {
    var list = CONFIG.basemaps || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) { return list[i]; }
    }
    return null;
  }

  function selectBasemap(key) {
    var bm = basemapByKey(key);
    if (!bm || key === currentBasemap) { return; }

    if (currentBasemap && basemapLayers[currentBasemap]) {
      map.removeLayer(basemapLayers[currentBasemap]);
    }

    if (!basemapLayers[key]) {
      basemapLayers[key] = L.tileLayer(bm.url, {
        // maxZoom is what the layer will render at; maxNativeZoom is how deep
        // the service actually goes. Without both, Leaflet either hides the
        // layer past its default z18 or requests tiles that 400/404.
        maxZoom: CONFIG.maxZoom || 20,
        maxNativeZoom: bm.maxNativeZoom,
        subdomains: bm.subdomains || "abc",
        attribution: bm.attribution
      });
    }

    basemapLayers[key].addTo(map);
    basemapLayers[key].bringToBack();
    currentBasemap = key;

    // Fatter white outlines so markers hold up over aerial imagery.
    map.getContainer().classList.toggle("basemap-dark", !!bm.dark);

    var rows = el("basemap-rows");
    Array.prototype.forEach.call(rows.children, function (btn) {
      var on = btn.getAttribute("data-key") === key;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });

    writeBasemapPref(key);
  }

  function renderBasemapSwitch() {
    var rows = el("basemap-rows");
    rows.textContent = "";

    (CONFIG.basemaps || []).forEach(function (bm) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "basemap-btn";
      btn.setAttribute("data-key", bm.key);
      btn.setAttribute("aria-pressed", "false");
      btn.textContent = bm.label;
      btn.onclick = function () { selectBasemap(bm.key); };
      rows.appendChild(btn);
    });

    el("legend").hidden = false;
  }

  /* ------------------------------------------------------------ date filter */

  function dateBounds() {
    var from = el("date-from").value || null;   // "YYYY-MM-DD" or ""
    var to = el("date-to").value || null;
    return { from: from, to: to, active: !!(from || to) };
  }

  function updateCounts() {
    var b = dateBounds();
    CONFIG.accounts.forEach(function (account) {
      var row = document.querySelector('.legend-count[data-key="' + account.key + '"]');
      if (!row) { return; }
      var total = counts[account.key] || 0;
      var shown = shownCounts[account.key] || 0;
      row.textContent = b.active ? shown + " of " + total : String(total);
      row.title = b.active ? shown + " of " + total + " photos in range" : total + " photos";
    });
  }

  // Rebuilds each cluster group from the markers whose date falls in range.
  // Undated images are dropped while a filter is on — they can't be shown to
  // fall inside it.
  function applyDateFilter() {
    var b = dateBounds();
    var note = el("date-note");
    var invalid = b.from && b.to && b.from > b.to;

    var totalShown = 0, undated = 0;

    CONFIG.accounts.forEach(function (account) {
      var group = groups[account.key];
      var all = markersOf[account.key];
      if (!group || !all) { return; }

      var keep = all;
      if (b.active && !invalid) {
        keep = all.filter(function (m) {
          if (!m.__date) { undated++; return false; }
          if (b.from && m.__date < b.from) { return false; }
          if (b.to && m.__date > b.to) { return false; }
          return true;
        });
      } else if (invalid) {
        keep = [];
      }

      group.clearLayers();
      group.addLayers(keep);
      shownCounts[account.key] = keep.length;
      totalShown += keep.length;
    });

    updateCounts();
    el("date-clear").hidden = !b.active;

    if (invalid) {
      note.textContent = "“From” is after “To”.";
      note.classList.add("is-warn");
    } else if (b.active && totalShown === 0) {
      // Deliberately not the full-screen overlay: that means "your config is
      // wrong", not "you picked a quiet week".
      note.textContent = "No photos in that range.";
      note.classList.add("is-warn");
    } else {
      note.classList.remove("is-warn");
      note.textContent = b.active
        ? (undated ? undated + " undated hidden" : "")
        : availableRangeLabel();
    }
  }

  var availableRange = { min: null, max: null };

  function availableRangeLabel() {
    if (!availableRange.min) { return ""; }
    return availableRange.min === availableRange.max
      ? availableRange.min
      : availableRange.min + " to " + availableRange.max;
  }

  // Bound the pickers to the data we actually have.
  function initDateRange() {
    var min = null, max = null;
    Object.keys(markersOf).forEach(function (k) {
      markersOf[k].forEach(function (m) {
        if (!m.__date) { return; }
        if (!min || m.__date < min) { min = m.__date; }
        if (!max || m.__date > max) { max = m.__date; }
      });
    });
    availableRange = { min: min, max: max };

    if (min) {
      ["date-from", "date-to"].forEach(function (id) {
        el(id).min = min;
        el(id).max = max;
      });
      el("legend-dates").hidden = false;
    }
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
      count.setAttribute("data-key", account.key);
      count.textContent = counts[account.key];

      label.appendChild(cb);
      label.appendChild(swatch);
      label.appendChild(name);
      label.appendChild(count);
      rows.appendChild(label);
    });

    el("legend-accounts").hidden = false;
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
    map = L.map("map", { zoomControl: true, maxZoom: CONFIG.maxZoom || 20 })
      .setView(CONFIG.defaultCenter, CONFIG.defaultZoom);

    // Pinned separately from the basemap credit, which swaps with the layer.
    map.attributionControl.addAttribution(
      'Imagery &copy; <a href="https://www.mapillary.com/">Mapillary</a> contributors');

    renderBasemapSwitch();

    var first = basemapByKey(readBasemapPref()) ||
                basemapByKey(CONFIG.defaultBasemap) ||
                (CONFIG.basemaps || [])[0];
    if (first) { selectBasemap(first.key); }

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
    initDateRange();
    applyDateFilter();
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
    el("date-from").onchange = applyDateFilter;
    el("date-to").onchange = applyDateFilter;
    el("date-clear").onclick = function () {
      el("date-from").value = "";
      el("date-to").value = "";
      applyDateFilter();
    };

    el("lightbox-close").onclick = closeLightbox;

    // Tell a tap apart from a pan: while zoomed, dragging to scroll ends in a
    // click on the photo, which shouldn't be read as "zoom back out".
    var downAt = null;
    el("lightbox").addEventListener("pointerdown", function (e) {
      downAt = { x: e.clientX, y: e.clientY };
    });
    el("lightbox").onclick = function (e) {
      var moved = downAt &&
        (Math.abs(e.clientX - downAt.x) > 8 || Math.abs(e.clientY - downAt.y) > 8);
      downAt = null;
      if (moved) { return; }
      if (e.target === el("lightbox-img")) {
        setZoomed(!el("lightbox").classList.contains("zoomed"));
      } else {
        closeLightbox();   // backdrop
      }
    };

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") { return; }
      if (closeLightbox()) { return; }
      if (!panelEl.hidden) { closePanel(); }
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
