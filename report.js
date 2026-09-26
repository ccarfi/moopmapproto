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
  var deviceDot = null;     // where the phone says it is — never the pin
  var deviceRing = null;    // its accuracy, drawn to scale
  var devicePos = null;     // the last device fix, kept for the cross-check
  var geoWatch = null;      // keeps looking after a pin is placed by hand
  var keptPin = null;       // km of disagreement the volunteer chose to keep
  var manualChosen = false; // they asked to place it themselves
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
    // the street", which happens a lot under tree cover — and for when the
    // device never reports at all.
    //
    // It is NOT available while we are still looking. A tappable map sitting
    // under "Finding your location…" is what produced two photos pinned 99 km
    // and 107 km from where they were taken: the volunteer got impatient, and
    // an equally available wrong answer was right there.
    map.on("click", function (e) {
      if (!placingAllowed()) { return; }
      setPosition(e.latlng.lat, e.latlng.lng, null, "user-adjusted");
    });
  }

  function recentreForChapter() {
    if (position) { return; }   // don't yank the pin out from under someone
    var c = selectedChapter();
    if (c && c.center) { map.setView(c.center, c.zoom || CONFIG.defaultZoom); }
  }

  // Where the phone says it is, drawn separately from the submission pin.
  //
  // The map has only ever shown where the pin IS, never where the device
  // THINKS IT IS. With both on screen a disagreement needs no threshold and no
  // explanation: a dot in Gilroy and a pin in Oakland is obvious to anyone.
  // This keeps working when a fix lands after a manual placement, which is the
  // case that put two photos 99 km and 107 km from where they were taken.
  function showDeviceDot(lat, lng, accuracy) {
    devicePos = { lat: lat, lng: lng, accuracy: accuracy };
    if (!map) { return; }

    if (!deviceDot) {
      deviceRing = L.circle([lat, lng], {
        radius: accuracy || 0, color: "#1a73e8", weight: 1,
        fillColor: "#1a73e8", fillOpacity: 0.12, interactive: false
      }).addTo(map);
      deviceDot = L.circleMarker([lat, lng], {
        radius: 6, color: "#fff", weight: 2,
        fillColor: "#1a73e8", fillOpacity: 1, interactive: false
      }).addTo(map);
      deviceDot.bindTooltip("Where your phone says you are", { direction: "top" });
    } else {
      deviceDot.setLatLng([lat, lng]);
      deviceRing.setLatLng([lat, lng]).setRadius(accuracy || 0);
    }
  }

  function kmApart(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // The geofence cannot catch a pin that is wrong but still inside a
  // nine-county box, and no box around a chapter that large ever could. The
  // device's own fix is the only independent signal available — so when one
  // arrives and disagrees with a hand-placed pin, ask.
  //
  // A question, not a block. The phone is sometimes the one that is wrong, and
  // someone reporting a spot they photographed earlier has a legitimately
  // disagreeing pin. What must not happen is the disagreement going unnoticed.
  function checkAgainstDevice() {
    var warn = el("geo-disagree");
    if (!warn) { return; }

    if (!devicePos || !position || position.source === "device") {
      warn.hidden = true;
      return;
    }

    var limit = (CONFIG.upload && CONFIG.upload.disagreeKm) || 1;
    var d = kmApart(position, devicePos);
    if (d < limit) { warn.hidden = true; keptPin = null; return; }

    var far = d >= 10 ? Math.round(d) + " km"
                      : (d >= 1 ? d.toFixed(1) + " km" : Math.round(d * 1000) + " m");

    warn.textContent = "";
    var p = document.createElement("p");
    p.textContent = "This pin is " + far + " from where your phone says you are.";
    warn.appendChild(p);

    var row = document.createElement("div");
    row.className = "disagree-row";

    var useDevice = document.createElement("button");
    useDevice.type = "button";
    useDevice.className = "btn btn-secondary";
    useDevice.textContent = "Use my phone's location";
    useDevice.onclick = function () {
      keptPin = null;
      setPosition(devicePos.lat, devicePos.lng, devicePos.accuracy, "device");
    };

    var keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn btn-secondary";
    keep.textContent = "Keep my pin";
    keep.onclick = function () {
      // Recorded, not just dismissed. A pin someone defended against their own
      // phone is not the same as one nobody ever questioned.
      keptPin = Math.round(d * 1000) / 1000;
      warn.hidden = true;
      updateSubmitNote();
    };

    row.appendChild(useDevice);
    row.appendChild(keep);
    warn.appendChild(row);
    warn.hidden = false;
  }

  // Placing by hand is available once the device has had its turn — it
  // succeeded and they want to correct it, it failed, or they said they would
  // rather do it themselves.
  function placingAllowed() {
    return manualChosen || !!position ||
           geoState === "denied" || geoState === "timeout" ||
           geoState === "unavailable";
  }

  function chooseManual() {
    manualChosen = true;
    renderLocationHelp();
    renderPlacingState();
    el("loc-status").textContent = "Tap the map to place the pin.";
  }

  // The map has to look like what it is: waiting, or ready.
  function renderPlacingState() {
    var wrap = el("mini-map");
    var pick = el("loc-manual");
    var allowed = placingAllowed();

    if (wrap) { wrap.classList.toggle("is-waiting", !allowed); }

    // Offered only while we are still looking — once placing is allowed the
    // map itself is the affordance and a second control is just noise.
    if (pick) { pick.hidden = allowed || geoState === "idle"; }
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
    renderPlacingState();
    checkBounds();
    checkAgainstDevice();
    updateSubmitNote();
  }

  // Brave blocks geolocation without prompting, so its users see no permission
  // dialog and no error — the request simply never resolves. Worth naming
  // explicitly, because "allow location" is useless advice there.
  function detectBrave() {
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === "function") {
        navigator.brave.isBrave().then(function (v) {
          isBrave = !!v;
          // Don't make Brave users sit out a 30 second count that cannot
          // finish. As soon as we know, give them the way through.
          if (isBrave && !position) {
            el("loc-status").textContent = "";
            setGeoState("denied");
          }
        });
      }
    } catch (e) { /* not Brave */ }
  }

  function setGeoState(state) {
    geoState = state;
    renderLocationHelp();
    renderPlacingState();
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
    // Locate-on-load and the retry when a photo is attached can both fire.
    // Two acquisitions means two tickers writing to the same status line.
    if (geoState === "asking") { return; }

    setGeoState("asking");

    // Silence is what invites someone to give up and tap. A count and an
    // expectation are the difference between waiting 30 seconds and waiting
    // ten.
    var began = Date.now();
    el("loc-status").textContent = "Finding your location…";
    var ticker = setInterval(function () {
      // Stop once there is an answer, or once they have taken over — otherwise
      // it overwrites "Tap the map to place the pin." a second later and the
      // instruction vanishes.
      if (position || manualChosen) { clearInterval(ticker); return; }
      var secs = Math.round((Date.now() - began) / 1000);
      el("loc-status").textContent =
        "Finding your location… " + secs + "s" +
        (secs >= 8 ? " — this can take up to 30 seconds outdoors" : "");
    }, 1000);

    // Belt and braces: some browsers neither resolve nor reject. Without this
    // the form would sit on "Getting your location…" forever.
    var settled = false;
    var watchdog = setTimeout(function () {
      if (settled) { return; }
      settled = true;
      clearInterval(ticker);
      el("loc-status").textContent = "";
      setGeoState("timeout");
    }, 30000);

    function done(state) {
      if (settled) { return; }
      settled = true;
      clearTimeout(watchdog);
      clearInterval(ticker);
      if (state) { setGeoState(state); }
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        done(null);
        showDeviceDot(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);

        // A fix arriving after someone has placed a pin by hand does NOT move
        // it. They made a deliberate choice, and silently overriding it is
        // both rude and wrong — the phone is sometimes the one in error. Show
        // the dot and let the disagreement check ask.
        if (position && position.source === "user-adjusted") {
          setGeoState("ok");
          checkAgainstDevice();
        } else {
          setPosition(pos.coords.latitude, pos.coords.longitude,
                      pos.coords.accuracy, "device");
          setGeoState("ok");
        }
        watchForDisagreement();
      },
      function (err) {
        el("loc-status").textContent = "";
        var why = err && err.code === err.PERMISSION_DENIED ? "denied" : "timeout";
        done(why);
        // A timeout is not a refusal — a fix may still arrive while they place
        // a pin, and that fix is exactly what catches a bad one.
        if (why === "timeout") { watchForDisagreement(); }
      },
      { enableHighAccuracy: true, timeout: 25000, maximumAge: 30000 }
    );
  }

  // The fix that catches a bad pin is often the one that arrives a moment too
  // late — the volunteer had already given up and tapped. So keep looking.
  function watchForDisagreement() {
    if (geoWatch !== null || !navigator.geolocation) { return; }
    try {
      geoWatch = navigator.geolocation.watchPosition(
        function (pos) {
          showDeviceDot(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
          checkAgainstDevice();
        },
        function () { /* a failed refresh changes nothing */ },
        { enableHighAccuracy: true, maximumAge: 15000 }
      );
    } catch (e) { /* unsupported */ }
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
      pinKeptDespiteKm: keptPin,
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
    if (deviceDot) { map.removeLayer(deviceDot); deviceDot = null; }
    if (deviceRing) { map.removeLayer(deviceRing); deviceRing = null; }
    devicePos = null;
    keptPin = null;
    manualChosen = false;
    if (el("geo-disagree")) { el("geo-disagree").hidden = true; }
    el("loc-coarse").hidden = true;
    el("geo-warn").hidden = true;
    el("loc-status").textContent = "";

    updateSubmitNote();
    renderLocationHelp();
    renderPlacingState();
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

    // NOT "tap the map". That was the first thing a volunteer read, before
    // anything had tried to locate them — the fallback presented as the
    // method. Two photos were sent 99 km and 107 km from where they were
    // taken by someone following it.
    el("loc-status").textContent = "Finding your location…";

    el("loc-manual").onclick = chooseManual;

    detectBrave();
    checkGeoPermission();

    // Start on load, so the fix resolves while a chapter is picked and the
    // photo is taken. Requesting it when the photo is attached meant
    // acquisition began at the moment of least patience.
    requestLocation();
    renderLocationHelp();
    updateSubmitNote();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
