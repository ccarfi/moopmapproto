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
  var dismissedDisagreement = false;  // they answered "keep my pin"
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
      // A tap is only as precise as the zoom allows. Refusing is better than
      // recording a guess to six decimal places.
      if (!zoomEnoughToPlace()) { renderPlacingState(); return; }
      setPosition(e.latlng.lat, e.latlng.lng, null, "user-adjusted");
    });

    // Not just when there is no pin yet: someone correcting a bad pin zooms
    // out to find the right area, and a tap refused with no explanation reads
    // as a broken map.
    map.on("zoomend", renderPlacingState);
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
  // How far the pin being submitted sits from the device's own fix, or null.
  //
  // Computed at the moment it is needed rather than stashed when a button was
  // pressed: a stashed value describes whichever disagreement was on screen
  // then, which is the wrong pin as soon as the volunteer moves it again. It
  // also means someone who ignores the prompt and submits anyway is recorded
  // accurately, instead of looking like they were never asked.
  function disagreementKm() {
    if (!devicePos || !position || position.source === "device") { return null; }
    var limit = (CONFIG.upload && CONFIG.upload.disagreeKm) || 1;
    var d = kmApart(position, devicePos);
    return d < limit ? null : Math.round(d * 1000) / 1000;
  }

  function checkAgainstDevice() {
    var warn = el("geo-disagree");
    if (!warn) { return; }

    var d = disagreementKm();
    if (d === null) { warn.hidden = true; dismissedDisagreement = false; return; }

    // A different disagreement is a different question, so it gets asked again
    // even if the last one was dismissed.
    if (dismissedDisagreement && warn.dataset.askedAbout === String(d)) {
      warn.hidden = true;
      return;
    }
    dismissedDisagreement = false;
    warn.dataset.askedAbout = String(d);

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
      dismissedDisagreement = false;
      setPosition(devicePos.lat, devicePos.lng, devicePos.accuracy, "device");
    };

    var keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn btn-secondary";
    keep.textContent = "Keep my pin";
    keep.onclick = function () {
      // Only dismisses the prompt. The distance itself is read off the pin at
      // submit time, so it always describes what is actually being sent.
      dismissedDisagreement = true;
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
  // The whole hand-placement path, behind one switch. Everything below it
  // still works; nothing below it is reachable while it is off.
  function manualPlacement() {
    return !!(CONFIG.upload && CONFIG.upload.allowManualPlacement);
  }

  function placingAllowed() {
    if (!manualPlacement()) { return false; }
    return manualChosen || !!position ||
           geoState === "denied" || geoState === "timeout" ||
           geoState === "unavailable";
  }

  function minZoom() {
    return (CONFIG.upload && CONFIG.upload.minPlacementZoom) || 15;
  }

  function zoomEnoughToPlace() {
    return !map || map.getZoom() >= minZoom();
  }

  function chooseManual() {
    manualChosen = true;
    // The mini-map is 150px tall; pinching from z9 to z15 is six gestures on
    // a phone held one-handed. Get them to a workable zoom in one step and let
    // them pan from there — the point is a deliberate placement, not a penance.
    if (map && map.getZoom() < minZoom()) {
      map.setZoom(minZoom());
    }
    renderLocationHelp();
    renderPlacingState();
  }

  // The map has to look like what it is: waiting, or ready.
  function renderPlacingState() {
    var wrap = el("mini-map");
    var pick = el("loc-manual");

    // With placement off the map is a display, not a control. Dim it only
    // while a fix is actually being sought: "not yet" is worth saying, but a
    // permanently grey box for someone whose location is blocked reads as a
    // broken map, and the message beneath it already carries the meaning.
    if (!manualPlacement()) {
      if (wrap) {
        wrap.classList.toggle("is-waiting", !position && geoState === "asking");
      }
      if (pick) { pick.hidden = true; }
      if (el("loc-zoomhint")) { el("loc-zoomhint").hidden = true; }
      return;
    }

    var allowed = placingAllowed();

    if (wrap) { wrap.classList.toggle("is-waiting", !allowed); }

    // Offered only while we are still looking — once placing is allowed the
    // map itself is the affordance and a second control is just noise.
    if (pick) { pick.hidden = allowed || geoState === "idle"; }

    // A separate line from the status, so it can be true at the same time as
    // the coordinates rather than overwriting them.
    var hint = el("loc-zoomhint");
    if (hint) { hint.hidden = !allowed || zoomEnoughToPlace(); }

    // Which of the two things the map is for. Only while there is no pin yet —
    // after that the status line carries the coordinates.
    if (allowed && !position) {
      el("loc-status").textContent = zoomEnoughToPlace()
        ? "Tap the map to place the pin."
        : "";
    }
  }

  function setPosition(lat, lng, accuracy, source) {
    position = { lat: lat, lng: lng, accuracy: accuracy, source: source };

    if (!marker) {
      marker = L.marker([lat, lng], { draggable: manualPlacement() }).addTo(map);
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
      coarse.textContent = manualPlacement()
        ? "Rough fix — drag the pin to be exact."
        : "Rough fix — for a better one, move into the open and tap Use my location.";
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

  // Brave used to be short-circuited straight to "blocked" on sight, because
  // it appeared to swallow geolocation silently. Field testing says otherwise:
  // Brave and Chrome on iOS both work flawlessly once Location Services is
  // enabled for the app in iOS Settings. What looked like a browser blocking
  // requests was the operating system never letting the browser ask.
  //
  // So detection now only names the app in the instructions. Declaring it
  // broken would deny a working browser its fix — and since #37 removed
  // hand-placement, that would leave the volunteer unable to report at all.
  function detectBrave() {
    if (/Brave\//.test(navigator.userAgent)) { isBrave = true; return; }
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === "function") {
        navigator.brave.isBrave().then(function (v) { isBrave = !!v; });
      }
    } catch (e) { /* not Brave */ }
  }

  // Which browser, so the instructions can name the row to tap in Settings.
  // Every iOS browser is WebKit underneath, so this is about the app the
  // volunteer is holding, not the engine.
  function platform() {
    var ua = navigator.userAgent;
    // iPadOS reports itself as a Mac, so a touch-capable "MacIntel" is taken
    // as an iPad — but only when the UA does not say Android, because an
    // emulated Android on a Mac satisfies both halves and would otherwise be
    // handed iPhone instructions.
    var android = /Android/.test(ua);
    var iOS = /iP(hone|ad|od)/.test(ua) ||
              (!android && navigator.platform === "MacIntel" &&
               navigator.maxTouchPoints > 1);
    var app = /CriOS\//.test(ua)  ? "Chrome"
            : /EdgiOS\//.test(ua) ? "Edge"
            : /FxiOS\//.test(ua)  ? "Firefox"
            : /Brave\//.test(ua) || isBrave ? "Brave"
            : iOS ? "Safari"
            : /Chrome\//.test(ua) ? "Chrome"
            : /Firefox\//.test(ua) ? "Firefox" : null;
    return { iOS: iOS, android: android, app: app };
  }

  // Two separate permissions have to be right on iOS, and the outer one is the
  // one that actually caught people out: the OS deciding whether the browser
  // app may know where it is at all. A volunteer who has only ever been told
  // "allow location" will look for a prompt that never appears.
  function locationSteps() {
    var p = platform();
    var app = p.app || "your browser";

    if (p.iOS) {
      return {
        title: "Turn on location for " + app,
        steps: [
          "Open Settings, then Privacy & Security, then Location Services",
          "Make sure Location Services is on",
          "Tap " + app + " and choose \u201cWhile Using the App\u201d",
          "Come back here \u2014 it will try again on its own"
        ]
      };
    }

    if (p.android) {
      // Android settings differ enough between manufacturers that naming exact
      // menus would be wrong as often as right. Name what to look for instead.
      return {
        title: "Turn on location for " + app,
        steps: [
          "Check Location is switched on in your phone's settings",
          "In your app settings, allow Location for " + app,
          "Come back here \u2014 it will try again on its own"
        ]
      };
    }

    return null;
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
      // Without hand-placement there is no "instead" to offer, so these say
      // what to do about it rather than pointing at a fallback that is gone.
      // Handling these cases properly is its own piece of work — see #38.
      msg = manualPlacement()
        ? "Location blocked. Tap the map instead."
        : "This page can't see where you are.";
    } else if (geoState === "timeout") {
      msg = manualPlacement()
        ? "No location yet. Tap the map instead."
        : "Couldn't find you. This is usually location services being off.";
    } else if (geoState === "unavailable") {
      msg = manualPlacement()
        ? "Location unavailable. Tap the map instead."
        : "This device can't share a location.";
    } else {
      help.hidden = true;
      return;
    }

    var steps = locationSteps();
    help.textContent = "";

    var line = document.createElement("p");
    line.textContent = msg;
    help.appendChild(line);

    if (steps) {
      var h = document.createElement("strong");
      h.textContent = steps.title;
      help.appendChild(h);

      var ol = document.createElement("ol");
      steps.steps.forEach(function (stepText) {
        var li = document.createElement("li");
        li.textContent = stepText;
        ol.appendChild(li);
      });
      help.appendChild(ol);
    }

    help.hidden = false;
  }

  // Worth another attempt: nothing found yet, and the last one actually
  // failed rather than still being in flight.
  function worthRetrying() {
    return !position &&
           (geoState === "denied" || geoState === "timeout" ||
            geoState === "unavailable");
  }

  function retryOnShow() {
    // No visibility test: a pageshow means this page is being displayed,
    // including a back-navigation restored from the cache.
    if (worthRetrying()) { requestLocation(); }
  }

  function retryOnVisible() {
    if (document.visibilityState !== "visible") { return; }
    if (worthRetrying()) { requestLocation(); }
  }

  function requestLocation() {
    if (!navigator.geolocation) { setGeoState("unavailable"); return; }
    // Locate-on-load and the retry when a photo is attached can both fire.
    // Two acquisitions means two tickers writing to the same status line.
    if (geoState === "asking") { return; }
    // A retry from a failed state is a new attempt, so the watchdog and the
    // counter start over rather than inheriting the last one.

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

  // Object URL for the preview. Held so it can be released — each call to
  // createObjectURL pins the whole file in memory until it is revoked, and a
  // 15 MB photo re-picked a few times adds up on a phone.
  var thumbUrl = null;

  // Swaps the picker for the photo it picked, and back again.
  //
  // Before: [Take photo] [No photo selected]. After: a thumbnail that is
  // itself the label, so tapping the photo you have is how you get a different
  // one. The button used to persist after the photo was taken, which invited
  // taking it twice, and the filename beside it carried nothing a volunteer
  // could use (#43).
  function renderPicked() {
    var name = el("photo-name");
    if (!name) { return; }
    var picked = el("photos").files;
    var file = (picked && picked.length) ? picked[0] : null;
    var thumb = el("photo-thumb");
    var img = el("photo-thumb-img");
    var pick = document.querySelector(".file-pick-btn");

    if (thumbUrl) { URL.revokeObjectURL(thumbUrl); thumbUrl = null; }

    if (!file) {
      thumb.hidden = true;
      img.removeAttribute("src");
      pick.hidden = false;
      name.hidden = false;
      name.textContent = "No photo selected";
      return;
    }

    // An object URL in an <img>, never a canvas. Canvas would re-encode, and
    // these are the exact bytes that get uploaded — see readBase64, which
    // avoids canvas for the same reason. This only displays them, so EXIF
    // survives untouched, and the browser honours the orientation tag when it
    // draws, so a portrait photo is not shown on its side.
    thumbUrl = URL.createObjectURL(file);
    img.src = thumbUrl;
    thumb.hidden = false;
    pick.hidden = true;
    name.hidden = true;
  }

  function onFilesPicked() {
    var picked = Array.prototype.slice.call(el("photos").files || []);
    files = [];
    renderPicked();

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
      pinKeptDespiteKm: disagreementKm(),
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

  /* --------------------------------------------------- send progress */

  // The bar is an estimate and cannot be anything else. fetch has no
  // upload-progress event, and attaching one to an XMLHttpRequest sets the
  // CORS preflight flag — which this endpoint cannot answer, because Apps
  // Script replies to /exec with a 302. Checked against production rather than
  // assumed: the identical request succeeds without an upload listener and is
  // blocked with one.
  //
  // So it is timed, and the throughput guess below is deliberately pessimistic.
  // Finishing early sweeps the bar to full, which reads as fast; finishing late
  // parks it at the ceiling. Given a choice of being wrong, be wrong in the
  // direction that flatters the upload.
  var BYTES_PER_MS = 150;    // ~1.2 Mbit/s — a bad rural uplink, not a good one
  var EASE_TO = 85;          // where the timed curve lands
  var CEILING = 97;          // the creep stops here; only a reply reaches 100
  var SWEEP_MS = 260;        // filling the last of the bar once the reply lands
  var HOLD_MS = 220;         // and letting a full bar be seen before it goes
  var progress = { raf: 0, floor: 0 };

  function setFill(pct) {
    el("submit-btn").style.setProperty("--fill", pct.toFixed(1) + "%");
  }

  function startProgress(bytes) {
    var btn = el("submit-btn");
    btn.classList.add("is-sending");
    btn.setAttribute("aria-busy", "true");
    progress.floor = 0;
    setFill(0);

    // base64 inflates the payload by about a third before it goes on the wire.
    var expected = Math.min(45000, 900 + (bytes * 4 / 3) / BYTES_PER_MS);
    var t0 = performance.now();

    (function step(now) {
      // Recomputed from elapsed time, never incremented, so a backgrounded tab
      // that stops firing frames catches up instead of falling behind.
      var elapsed = (now || performance.now()) - t0;
      var pct;
      if (elapsed < expected) {
        var t = elapsed / expected;
        pct = EASE_TO * (1 - Math.pow(1 - t, 2));   // quick, then patient
      } else {
        // Asymptotic. It never arrives; only the response finishes it.
        pct = EASE_TO + (CEILING - EASE_TO) *
              (1 - Math.exp(-(elapsed - expected) / 15000));
      }
      setFill(Math.max(pct, progress.floor));
      progress.raf = requestAnimationFrame(step);
    })();
  }

  // With more than one photo each completion is a real milestone, so the bar is
  // allowed to jump to it rather than wait for the clock.
  function progressFloor(done, total) {
    progress.floor = EASE_TO * (done / total);
  }

  function endProgress(sent) {
    cancelAnimationFrame(progress.raf);
    var btn = el("submit-btn");
    var from = parseFloat(btn.style.getPropertyValue("--fill")) || 0;
    var t0 = performance.now();

    // Swept rather than snapped, because the common case is finishing early
    // from a low fill and an instant jump there reads as a glitch.
    //
    // The timer owns completion and the animation only paints. Hanging the
    // promise off the frame chain instead meant that backgrounding the tab
    // during the sweep — switching apps mid-send, which is an ordinary thing
    // to do on a phone — stopped requestAnimationFrame, left the promise
    // unresolved and the confirmation never arrived.
    return new Promise(function (resolve) {
      var settled = false;

      function finish() {
        if (settled) { return; }
        settled = true;
        btn.classList.remove("is-sending");
        btn.removeAttribute("aria-busy");
        btn.style.removeProperty("--fill");
        resolve();
      }

      // A send that failed must not end on a full bar. The error underneath is
      // the message, and a completed bar above it reads as a contradiction, so
      // the fill is abandoned where it stood rather than swept home.
      if (!sent) { setTimeout(finish, HOLD_MS); return; }

      // Sweep, then let a full bar be seen before the button changes back.
      // This replaces the old 400ms floor under "Sending…" — same job, done
      // visibly.
      setTimeout(finish, SWEEP_MS + HOLD_MS);

      (function sweep(now) {
        if (settled) { return; }
        var t = Math.min(1, ((now || performance.now()) - t0) / SWEEP_MS);
        setFill(from + (100 - from) * t);
        if (t < 1) { requestAnimationFrame(sweep); }
      })();
    });
  }

  async function retryOne(i) {
    if (submitting) { return; }
    submitting = true;
    var btn = el("submit-btn");
    btn.disabled = true;
    // A retry is the same work as a send and used to show nothing at all — the
    // button simply greyed out. Same treatment, or the retry path looks broken
    // next to the one it is retrying.
    btn.textContent = "Sending…";
    startProgress(files[i].file.size);
    var ok = await sendOne(i);
    await endProgress(ok);
    submitting = false;
    btn.textContent = "Send photo";
    btn.disabled = false;
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
    renderPicked();
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
    dismissedDisagreement = false;
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
    var btn = el("submit-btn");
    btn.disabled = true;
    btn.textContent = "Sending…";

    var bytes = 0;
    todo.forEach(function (i) { bytes += files[i].file.size; });
    startProgress(bytes);

    // One request per photo, in sequence: base64 inflates the payload by about
    // a third, and a failure part-way through then only costs that one photo.
    var anySent = false;
    for (var k = 0; k < todo.length; k++) {
      if (await sendOne(todo[k])) { anySent = true; }
      progressFloor(k + 1, todo.length);
    }

    await endProgress(anySent);

    submitting = false;
    btn.textContent = "Send photo";
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

    // The instructions send them to Settings and back. Trying again on return
    // is what makes "come back here — it will try again on its own" true,
    // instead of leaving them on a stale error they have already fixed.
    //
    // Only from a failed state, so a volunteer who simply switched apps for a
    // moment is not re-prompted for nothing.
    document.addEventListener("visibilitychange", retryOnVisible);
    window.addEventListener("pageshow", retryOnShow);

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
