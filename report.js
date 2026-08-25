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

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20,
      maxNativeZoom: 20,
      subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
        'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
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
    if (source === "user-adjusted") { bits.push("adjusted by hand"); }
    el("loc-status").textContent = bits.join(" · ") + ". Drag the pin to correct it.";

    checkBounds();
    updateSubmitNote();
  }

  function requestLocation() {
    if (!navigator.geolocation) {
      el("loc-status").textContent =
        "This browser can't share a location. Tap the map to drop a pin instead.";
      return;
    }

    el("loc-status").textContent = "Getting your location…";

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        setPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, "device");
      },
      function (err) {
        // Not fatal: the photo's own EXIF may carry a position, and the pin can
        // be dropped by hand.
        el("loc-status").textContent = err.code === err.PERMISSION_DENIED
          ? "Location permission denied. Tap the map to drop a pin, or send anyway — "
            + "your photo may already carry its own location."
          : "Couldn't get a location. Tap the map to drop a pin instead.";
        updateSubmitNote();
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
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
      warn.textContent = "That location looks outside " + c.label +
        ". Check the chapter above, or drag the pin. You can still send it.";
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

  function humanSize(bytes) {
    return bytes >= 1024 * 1024
      ? (bytes / 1024 / 1024).toFixed(1) + " MB"
      : Math.round(bytes / 1024) + " KB";
  }

  function onFilesPicked() {
    var picked = Array.prototype.slice.call(el("photos").files || []);
    files = [];

    picked.slice(0, maxPhotos()).forEach(function (f) {
      files.push({
        file: f,
        status: f.size > maxBytes() ? "too-big" : "ready",
        error: f.size > maxBytes() ? "Too large (" + humanSize(f.size) + ")" : null
      });
    });

    if (picked.length > maxPhotos()) {
      el("photos-hint").textContent =
        "Only the first " + maxPhotos() + " photos will be sent.";
    }

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

  function updateSubmitNote() {
    var note = el("submit-note");
    var btn = el("submit-btn");

    if (!endpointReady()) {
      btn.disabled = true;
      note.textContent = "";
      return;
    }

    var n = sendable();
    btn.disabled = n === 0 || submitting;
    note.textContent = n === 0
      ? "Choose at least one photo."
      : (position
          ? ""
          : "No location yet — we'll fall back to whatever the photo itself carries.");
  }

  function finishIfDone() {
    var sent = files.filter(function (f) { return f.status === "sent"; }).length;
    var failed = files.filter(function (f) { return f.status === "failed"; }).length;

    if (sent === 0) { return; }

    var box = el("result");
    box.hidden = false;
    box.className = "result " + (failed ? "is-warn" : "is-ok");
    box.textContent = "";

    var h = document.createElement("strong");
    h.textContent = failed
      ? sent + " of " + (sent + failed) + " photos sent"
      : (sent === 1 ? "Photo sent" : sent + " photos sent");
    box.appendChild(h);

    var p = document.createElement("p");
    // Deliberately not "added to the map" — these are batch-uploaded to
    // Mapillary and then have to be processed, which takes days, not seconds.
    p.textContent = failed
      ? "Retry the ones that failed above. Sent photos will appear on the map " +
        "once they've been uploaded to Mapillary and processed, usually within a few days."
      : "Thanks. They'll appear on the map once they've been uploaded to " +
        "Mapillary and processed, usually within a few days — not straight away.";
    box.appendChild(p);

    if (!failed) {
      var again = document.createElement("button");
      again.type = "button";
      again.className = "btn btn-secondary";
      again.textContent = "Send more";
      again.onclick = resetForm;
      box.appendChild(again);
    }
  }

  function resetForm() {
    files = [];
    submissionId = null;
    el("photos").value = "";
    el("result").hidden = true;
    el("photos-hint").textContent =
      "Take a new photo or pick existing ones. Please don't crop or edit them " +
      "first — the original file carries the location and time.";
    renderFiles();
    updateSubmitNote();
    window.scrollTo(0, 0);
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

    // One request per photo, in sequence: base64 inflates the payload by about
    // a third, and a failure part-way through then only costs that one photo.
    for (var k = 0; k < todo.length; k++) {
      await sendOne(todo[k]);
    }

    submitting = false;
    el("submit-btn").textContent = "Send photos";
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

    el("loc-status").textContent =
      "Tap “Use my location”, or tap the map to drop a pin.";

    updateSubmitNote();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
