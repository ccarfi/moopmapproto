/* "Tell us about MOOP" report form.
 *
 * Collects photos plus a position and posts them one at a time to a Google
 * Apps Script Web App, which files them in Drive and logs a row in a Sheet.
 * From there they are batch-uploaded to Mapillary — see RUNBOOK.md.
 *
 * Depends on Leaflet (CDN) and CONFIG from config.js.
 */
(function () {
  "use strict";

  var CHAPTER_PREF = "moopmap:chapter";

  var map, marker;
  var position = null;      // { lat, lng, accuracy, source }
  var files = [];           // { file, status, error, li }
  var submitting = false;
  var geoState = "idle";    // idle | asking | ok | denied | timeout | unavailable
  var isBrave = false;

  function el(id) { return document.getElementById(id); }

  function chapters() { return (CONFIG.accounts || []); }

  function chapterByKey(key) {
    var list = chapters();
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) { return list[i]; }
    }
    return null;
  }

  function selectedChapter() { return chapterByKey(el("chapter").value); }

  function endpointReady() {
    var u = CONFIG.upload && CONFIG.upload.endpoint;
    return !!u && u.indexOf("PASTE_") === -1;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) { return crypto.randomUUID(); }
    return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  /* ----------------------------------------------------------- chapters */

  function initChapters() {
    var sel = el("chapter");
    sel.textContent = "";

    chapters().forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c.key;
      opt.textContent = c.label;
      sel.appendChild(opt);
    });

    var saved = null;
    try { saved = localStorage.getItem(CHAPTER_PREF); } catch (e) { /* private mode */ }
    if (saved && chapterByKey(saved)) { sel.value = saved; }

    sel.onchange = function () {
      try { localStorage.setItem(CHAPTER_PREF, sel.value); } catch (e) { /* private mode */ }
      recentreForChapter();
      checkBounds();
    };
  }

  /* ----------------------------------------------------------- location */

  function initMap() {
    var c = selectedChapter();
    var centre = (c && c.center) || CONFIG.defaultCenter;
    var zoom = (c && c.zoom) || CONFIG.defaultZoom;

    map = L.map("mini-map", { zoomControl: true }).setView(centre, zoom);

    // Was CARTO Positron; CARTO now stamps "API KEY REQUIRED" across its tiles.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20,
      maxNativeZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // Tapping the map is the fallback for "the GPS put me on the wrong side of
    // the street", which happens a lot under tree cover.
    map.on("click", function (e) {
      setPosition(e.latlng.lat, e.latlng.lng, null, "user-adjusted");
    });
  }

  function recentreForChapter() {
    if (position) { return; }   // don't yank the pin out from under someone
    var c = selectedChapter();
    if (c && c.center) { map.setView(c.center, c.zoom || CONFIG.defaultZoom); }
  }

  function setPosition(lat, lng, accuracy, source) {
    position = { lat: lat, lng: lng, accuracy: accuracy, source: source };

    if (!marker) {
      marker = L.marker([lat, lng], { draggable: true }).addTo(map);
      marker.on("dragend", function () {
        var p = marker.getLatLng();
        setPosition(p.lat, p.lng, null, "user-adjusted");
      });
    } else {
      marker.setLatLng([lat, lng]);
    }

    map.setView([lat, lng], Math.max(map.getZoom(), 16));

    var bits = [lat.toFixed(6) + ", " + lng.toFixed(6)];
    if (accuracy) { bits.push("±" + Math.round(accuracy) + " m"); }
    if (source === "user-adjusted") { bits.push("placed by hand"); }
    el("loc-status").textContent = bits.join(" · ");

    // A wifi-derived fix indoors can be 50m+ out, which is too coarse to say
    // which patch of ground a photo is of. Say so rather than silently
    // recording it.
    var coarse = el("loc-coarse");
    var limit = (CONFIG.upload && CONFIG.upload.coarseAccuracyM) || 50;
    if (accuracy && accuracy > limit) {
      coarse.textContent = "Rough fix — drag the pin to be exact.";
      coarse.hidden = false;
    } else {
      coarse.hidden = true;
    }

    renderLocationHelp();
    checkBounds();
    updateSubmitNote();
  }

  // Brave blocks geolocation without prompting, so its users see no permission
  // dialog and no error — the request simply never resolves. Worth naming
  // explicitly, because "allow location" is useless advice there.
  function detectBrave() {
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === "function") {
        navigator.brave.isBrave().then(function (v) { isBrave = !!v; });
      }
    } catch (e) { /* not Brave */ }
  }

  function setGeoState(state) {
    geoState = state;
    renderLocationHelp();
    updateSubmitNote();
  }

  function renderLocationHelp() {
    var help = el("loc-help");

    if (position) { help.hidden = true; return; }

    // Only speak up when something has actually gone wrong. "You haven't set a
    // location yet" is already said three other ways — the required badge, the
    // status line under the map, and the note by the button — so saying it
    // again here was just noise.
    var msg;
    if (geoState === "denied") {
      // One line on a phone, so these give the fix rather than the reason.
      msg = isBrave
        ? "Brave blocks location. Tap the map instead."
        : "Location blocked. Tap the map instead.";
    } else if (geoState === "timeout") {
      msg = "No location yet. Tap the map instead.";
    } else if (geoState === "unavailable") {
      msg = "Location unavailable. Tap the map instead.";
    } else {
      help.hidden = true;
      return;
    }

    help.textContent = msg;
    help.hidden = false;
  }

  function requestLocation() {
    if (!navigator.geolocation) { setGeoState("unavailable"); return; }

    setGeoState("asking");
    el("loc-status").textContent = "Getting your location…";

    // Belt and braces: some browsers neither resolve nor reject. Without this
    // the form would sit on "Getting your location…" forever.
    var settled = false;
    var watchdog = setTimeout(function () {
      if (settled) { return; }
      settled = true;
      el("loc-status").textContent = "";
      setGeoState("timeout");
    }, 20000);

    function done(state) {
      if (settled) { return; }
      settled = true;
      clearTimeout(watchdog);
      if (state) { setGeoState(state); }
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        done(null);
        setPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, "device");
        setGeoState("ok");
      },
      function (err) {
        el("loc-status").textContent = "";
        done(err && err.code === err.PERMISSION_DENIED ? "denied" : "timeout");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  }

  // Ask up front where supported, so a already-blocked browser can say so
  // before the volunteer has picked photos and hit a dead end.
  function checkGeoPermission() {
    if (!navigator.permissions || !navigator.permissions.query) { return; }
    try {
      navigator.permissions.query({ name: "geolocation" }).then(function (status) {
        if (status.state === "denied" && !position) { setGeoState("denied"); }
        status.onchange = function () {
          if (status.state === "granted" && !position) { requestLocation(); }
          else if (status.state === "denied" && !position) { setGeoState("denied"); }
        };
      });
    } catch (e) { /* unsupported query name */ }
  }

  function inBounds(p, chapter) {
    if (!p || !chapter || !chapter.bounds) { return null; }   // unknown
    var b = chapter.bounds;
    return p.lng >= b.west && p.lng <= b.east && p.lat >= b.south && p.lat <= b.north;
  }

  function checkBounds() {
    var warn = el("geo-warn");
    var c = selectedChapter();
    var ok = inBounds(position, c);

    if (ok === false) {
      warn.textContent = "This location seems far away from " + c.label +
        " — check the chapter at the top of the form.";
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }

  /* -------------------------------------------------------------- files */

  function maxBytes() {
    return (CONFIG.upload && CONFIG.upload.maxFileMB ? CONFIG.upload.maxFileMB : 15) * 1024 * 1024;
  }

  function maxPhotos() {
    return (CONFIG.upload && CONFIG.upload.maxPhotos) ? CONFIG.upload.maxPhotos : 10;
  }

  function isJpeg(file) {
    var type = (file.type || "").toLowerCase();
    if (type) { return type === "image/jpeg" || type === "image/jpg"; }
    return /\.jpe?g$/i.test(file.name || "");   // some pickers report no type
  }

  function humanSize(bytes) {
    return bytes >= 1024 * 1024
      ? (bytes / 1024 / 1024).toFixed(1) + " MB"
      : Math.round(bytes / 1024) + " KB";
  }

  function onFilesPicked() {
    var picked = Array.prototype.slice.call(el("photos").files || []);
    files = [];

    // maxPhotos is 1; slice keeps this honest if that ever changes.
    picked.slice(0, maxPhotos()).forEach(function (f) {
      var status = "ready", error = null;

      // Mapillary only accepts JPEG, so a PNG can never be uploaded — and a
      // screenshot is a PNG, which is an easy thing to send by mistake. Say so
      // here rather than letting it sit in the queue unuploadable.
      if (!isJpeg(f)) {
        status = "bad-type";
        error = "Not a JPEG — send a photo, not a screenshot";
      } else if (f.size > maxBytes()) {
        status = "too-big";
        error = "Too large (" + humanSize(f.size) + ")";
      }

      files.push({ file: f, status: status, error: error });
    });

    renderFiles();
    updateSubmitNote();

    // Picking files is a user gesture, which is the right moment to ask for
    // location — asking on page load gets denied far more often.
    if (files.length && !position) { requestLocation(); }
  }

  function renderFiles() {
    var list = el("file-list");
    list.textContent = "";

    files.forEach(function (item, i) {
      var li = document.createElement("li");
      li.className = "file-row is-" + item.status;

      var name = document.createElement("span");
      name.className = "file-name";
      name.textContent = item.file.name;

      var status = document.createElement("span");
      status.className = "file-status";
      status.textContent = fileStatusText(item);

      li.appendChild(name);
      li.appendChild(status);

      if (item.status === "failed") {
        var retry = document.createElement("button");
        retry.type = "button";
        retry.className = "file-retry";
        retry.textContent = "Retry";
        retry.onclick = function () { retryOne(i); };
        li.appendChild(retry);
      }

      item.li = li;
      list.appendChild(li);
    });
  }

  function fileStatusText(item) {
    switch (item.status) {
      case "ready":    return humanSize(item.file.size);
      case "sending":  return "Sending…";
      case "sent":     return "Sent ✓";
      case "failed":   return item.error || "Failed";
      case "too-big":  return item.error;
      case "bad-type": return item.error;
      default:         return "";
    }
  }

  function setStatus(i, status, error) {
    files[i].status = status;
    files[i].error = error || null;
    renderFiles();
  }

  /* ------------------------------------------------------------ sending */

  // Reads the file's raw bytes. Deliberately NOT via canvas — drawing an image
  // to a canvas re-encodes it and strips EXIF, which is where the photo's own
  // GPS and capture time live.
  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var s = String(reader.result);
        var comma = s.indexOf(",");
        resolve(comma === -1 ? s : s.slice(comma + 1));
      };
      reader.onerror = function () { reject(new Error("Could not read the file")); };
      reader.readAsDataURL(file);
    });
  }

  function postPhoto(payload) {
    // text/plain keeps this a CORS "simple request". Apps Script Web Apps
    // answer with a redirect that fails preflight, so sending JSON with an
    // application/json content type does not work.
    return fetch(CONFIG.upload.endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
        if (!res.ok) { throw new Error((body && body.error) || ("HTTP " + res.status)); }
        if (!body || !body.ok) { throw new Error((body && body.error) || "Upload rejected"); }
        return body;
      });
    });
  }

  var submissionId = null;

  function payloadFor(item, index) {
    var c = selectedChapter();
    return {
      token: CONFIG.upload.token,
      website: el("hp-field").value,          // honeypot; must stay empty
      submissionId: submissionId,
      bwb_chapter: c ? c.key : null,
      index: index + 1,
      total: files.length,
      filename: item.file.name,
      mimeType: item.file.type || "image/jpeg",
      size: item.file.size,
      dataBase64: item.base64,
      lat: position ? position.lat : null,
      lng: position ? position.lng : null,
      accuracy: position ? position.accuracy : null,
      positionSource: position ? position.source : null,
      inChapterBounds: (function () {
        var v = inBounds(position, c);
        return v === null ? "unknown" : String(v);
      })(),
      clientTime: new Date().toISOString(),
      userAgent: navigator.userAgent
    };
  }

  async function sendOne(i) {
    var item = files[i];
    setStatus(i, "sending");
    try {
      if (!item.base64) { item.base64 = await readBase64(item.file); }
      await postPhoto(payloadFor(item, i));
      setStatus(i, "sent");
      return true;
    } catch (err) {
      setStatus(i, "failed", err.message || String(err));
      return false;
    }
  }

  async function retryOne(i) {
    if (submitting) { return; }
    submitting = true;
    el("submit-btn").disabled = true;
    await sendOne(i);
    submitting = false;
    el("submit-btn").disabled = false;
    finishIfDone();
  }

  function sendable() {
    return files.filter(function (f) {
      return f.status === "ready" || f.status === "failed";
    }).length;
  }

  function rejected() {
    return files.filter(function (f) {
      return f.status === "bad-type" || f.status === "too-big";
    }).length;
  }

  function updateSubmitNote() {
    var note = el("submit-note");
    var btn = el("submit-btn");

    if (!endpointReady()) {
      btn.disabled = true;
      note.textContent = "";
      return;
    }

    var n = sendable();

    // A location is required, not preferred. Phones strip EXIF when a photo
    // goes through a file input, so there is no second source to fall back on:
    // a report sent without a position can never be placed on the map.
    btn.disabled = n === 0 || !position || submitting;

    if (n === 0 && rejected()) {
      note.textContent = "That file can't be used — choose another.";
    } else if (n === 0) {
      note.textContent = "Choose a photo.";
    } else if (!position) {
      note.textContent = "Add a location first.";
    } else {
      note.textContent = "";
    }
  }

  function finishIfDone() {
    var sent = files.filter(function (f) { return f.status === "sent"; }).length;
    var failed = files.filter(function (f) { return f.status === "failed"; }).length;

    if (sent === 0) { return; }

    var box = el("result");

    // Unhidden before it is filled, deliberately: role="status" announces
    // mutations inside a live region that is already rendered, so populating a
    // still-hidden box can pass a screen reader by in silence.
    box.hidden = false;
    box.className = "result " + (failed ? "is-warn" : "is-ok");
    box.textContent = "";

    // Nothing left to send, so the submit button has no job — and a disabled
    // grey button sitting where the confirmation belongs is what pushed the
    // confirmation off-screen in the first place. Anything that failed keeps
    // the button, because retrying needs it.
    if (!failed) {
      el("submit-area").hidden = true;
      el("report-form").classList.add("is-done");
    }

    var h = document.createElement("strong");
    h.textContent = "Photo sent";
    box.appendChild(h);

    var p = document.createElement("p");
    // Deliberately not "added to the map" — these are batch-uploaded to
    // Mapillary and then have to be processed, which takes days, not seconds.
    p.textContent =
      "Thanks. It'll appear on the map once it's been uploaded to Mapillary and " +
      "processed, usually within a few days — not straight away.";
    box.appendChild(p);

    if (!failed) {
      var again = document.createElement("button");
      again.type = "button";
      again.className = "btn btn-secondary";
      again.textContent = "Send another photo";
      again.onclick = resetForm;
      box.appendChild(again);
    }
  }

  function resetForm() {
    files = [];
    submissionId = null;
    el("photos").value = "";
    el("result").hidden = true;
    el("submit-area").hidden = false;
    el("report-form").classList.remove("is-done");
    renderFiles();

    // Drop the previous report's position and take a fresh reading. Carrying it
    // over would reintroduce exactly the bug that made this form one-photo-only:
    // a pin that belongs to the last photo silently attached to the next one,
    // taken somewhere else.
    position = null;
    if (marker) { map.removeLayer(marker); marker = null; }
    el("loc-coarse").hidden = true;
    el("geo-warn").hidden = true;
    el("loc-status").textContent = "";

    updateSubmitNote();
    renderLocationHelp();
    window.scrollTo(0, 0);

    if (navigator.geolocation && geoState !== "denied" && geoState !== "unavailable") {
      requestLocation();
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting || !endpointReady()) { return; }

    var todo = [];
    files.forEach(function (f, i) {
      if (f.status === "ready" || f.status === "failed") { todo.push(i); }
    });
    if (!todo.length) { return; }

    if (!submissionId) { submissionId = uuid(); }

    submitting = true;
    el("submit-btn").disabled = true;
    el("submit-btn").textContent = "Sending…";

    // On a fast connection the whole send can finish inside a frame or two, so
    // "Sending…" flashes and the confirmation appears to come from nowhere.
    // Hold the sending state briefly so the swap reads as a sequence.
    var sendingSince = Date.now();

    // One request per photo, in sequence: base64 inflates the payload by about
    // a third, and a failure part-way through then only costs that one photo.
    for (var k = 0; k < todo.length; k++) {
      await sendOne(todo[k]);
    }

    var shown = Date.now() - sendingSince;
    if (shown < 400) { await new Promise(function (r) { setTimeout(r, 400 - shown); }); }

    submitting = false;
    el("submit-btn").textContent = "Send photo";
    updateSubmitNote();
    finishIfDone();
  }

  /* --------------------------------------------------------------- boot */

  function init() {
    if (!endpointReady()) { el("setup-warning").hidden = false; }

    initChapters();
    initMap();

    el("photos").onchange = onFilesPicked;
    el("loc-btn").onclick = requestLocation;
    el("report-form").onsubmit = onSubmit;

    el("loc-status").textContent = "Tap the map to place the pin.";

    detectBrave();
    checkGeoPermission();
    renderLocationHelp();
    updateSubmitNote();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
