/* Which build is this phone actually running?
 *
 * WHY THIS EXISTS
 *     GitHub Pages serves this site with Cache-Control: max-age=600, so for
 *     ten minutes after a deploy a browser keeps running the old code and
 *     gives no sign of it. Chrome holds on longer than that in practice. The
 *     failure is quiet and expensive: a change gets declared broken when the
 *     browser simply never fetched it.
 *
 * HOW IT DECIDES
 *     Not from a version constant. One of those only tells you what you are
 *     running, and standing on a kerb in Gilroy you will not remember what the
 *     latest is. It asks the server instead: every file this page loaded is
 *     fetched twice, once from the cache and once past it, and their
 *     Last-Modified headers are compared. That measures the deploy itself, so
 *     there is no number to bump and none to forget.
 *
 *     Each file is checked on its own. A fresh report.html holding a stale
 *     app.js is a real state, and one site-wide version string would call it
 *     current.
 *
 * WHAT IT CANNOT SEE
 *     `cache: "force-cache"` asks for the stored copy without revalidating,
 *     which is what makes the comparison honest about what the browser is
 *     holding. Safari before 16.4 ignores the option and revalidates anyway;
 *     there this under-reports — it can say "current" when the page is stale.
 *     It cannot fail the other way, so it will never send you to reload for
 *     nothing.
 *
 *     It also reads the HTTP cache, which is normally the same entry the
 *     <script> tag used but is not guaranteed to be.
 *
 *     The Apps Script half is a hand-set constant (CODE_VERSION in Code.gs),
 *     because a script has no way to read its own deployment date.
 *
 * WHERE IT RUNS
 *     report.html only. It was on the map too and came off in #40 — that page
 *     is for volunteers looking at photos, and a build stamp in the corner was
 *     just noise to them.
 *
 * USE
 *     Add <div id="version" class="version" hidden></div> to the page and load
 *     this file last. Add data-api to that element on a page that talks to the
 *     Apps Script, and the badge reports the backend version too — that part
 *     needs api-probe.js loaded as well, and says "api not checked" rather
 *     than nothing if it is missing.
 */
(function () {
  "use strict";

  var el = document.getElementById("version");
  if (!el) { return; }
  if (typeof fetch !== "function" || typeof Promise !== "function") { return; }
  // file:// has no server to ask, and nothing to be stale against.
  if (location.protocol !== "http:" && location.protocol !== "https:") { return; }

  function bust(url) {
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "_=" + Date.now();
  }

  /* Everything this page loaded from our own origin — the document, its
     scripts, its stylesheets. Read off the DOM rather than listed by hand, so
     a file added later is covered without anyone remembering to come here. */
  function ownAssets() {
    var out = [], seen = {}, i;

    function add(url) {
      var u;
      if (!url) { return; }
      try { u = new URL(url, location.href); } catch (e) { return; }
      if (u.origin !== location.origin) { return; }   // Leaflet's CDN is not ours
      u.hash = "";
      if (!seen[u.href]) { seen[u.href] = 1; out.push(u.href); }
    }

    add(location.href);
    for (i = 0; i < document.scripts.length; i++) { add(document.scripts[i].src); }
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (i = 0; i < links.length; i++) { add(links[i].href); }
    return out;
  }

  /* Both headers, not whichever is present. GitHub Pages sends Last-Modified
     and ETag, and both are unaffected by the cache-busting query string
     (checked 2026-09-27) — but picking per response could end up comparing one
     side's Last-Modified against the other's ETag, which differs every time
     and would send you to reload for nothing. */
  function stamp(res) {
    return { lm: res.headers.get("last-modified"), etag: res.headers.get("etag") };
  }

  function differs(a, b) {
    if (a.lm && b.lm) { return a.lm !== b.lm; }
    if (a.etag && b.etag) { return a.etag !== b.etag; }
    return false;   // nothing comparable — unknown, which must not read as stale
  }

  function checkOne(url) {
    return Promise.all([
      fetch(url, { cache: "force-cache" }),           // what we are holding
      fetch(bust(url), { method: "HEAD", cache: "no-store" })  // what is live
    ]).then(function (r) {
      var mine = stamp(r[0]);
      return { url: url, mine: mine.lm, stale: differs(mine, stamp(r[1])) };
    }).catch(function () {
      return { url: url, mine: null, stale: false };
    });
  }

  /* The backend half comes from api-probe.js, which the form also reads, so
     the page asks the endpoint once rather than once per interested party.

     This used to do its own fetch and collapse every outcome to null, which is
     how #61 happened: the badge was the only outward-facing thing on the page
     during a multi-day outage, it saw the failure, and it rendered a missing
     line. A missing line reads as fine. */
  function apiState() {
    // Guarded, not assumed: this runs while building the Promise.all argument,
    // so a bare reference to a name that never loaded would throw straight
    // past the catch below and out of this file.
    if (typeof MOOPMAP_API === "undefined") {
      // data-api is set, so this page claims to talk to the Apps Script, and
      // the file that would find out is not here. Say that. The alternative is
      // reporting silence, and silence is what this whole exercise was about.
      return Promise.resolve({ state: "unwired" });
    }
    return MOOPMAP_API.probe().catch(function () {
      return { state: "unwired" };
    });
  }

  function when(httpDate) {
    var t = Date.parse(httpDate || "");
    return isNaN(t) ? null : new Date(t);
  }

  function short(d) {
    return d.toLocaleString([], { day: "numeric", month: "short",
                                  hour: "2-digit", minute: "2-digit" });
  }

  function row(label, value) {
    var p = document.createElement("div");
    p.className = "version-row";
    var k = document.createElement("span");
    k.className = "version-key";
    k.textContent = label;
    p.appendChild(k);
    p.appendChild(document.createTextNode(value));
    return p;
  }

  /* cache: "reload" goes past the cache AND replaces what is stored, so the
     reload that follows picks up the new copy. A plain location.reload() on
     its own re-reads the same stale entries and changes nothing. */
  function refresh(btn, files) {
    btn.disabled = true;
    btn.textContent = "Reloading…";
    Promise.all(files.map(function (f) {
      return fetch(f.url, { cache: "reload" }).catch(function () { });
    })).then(function () { location.reload(); });
  }

  function render(files, api) {
    var newest = null, stale = 0;

    files.forEach(function (f) {
      if (f.stale) { stale++; }
      var d = when(f.mine);
      // Newest, not oldest: it names the deploy this page picked up. When one
      // file is behind, the badge is in its loud state anyway and the date
      // stops being the thing anyone reads.
      if (d && (!newest || d > newest)) { newest = d; }
    });

    el.hidden = false;
    el.className = el.className.replace(/\s*is-stale/, "") + (stale ? " is-stale" : "");

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "version-btn";

    // Stale wins over an unreachable backend. Nothing can be diagnosed from
    // code that is not the code that was deployed, so the first move is always
    // to get the right build; the next load will report the endpoint if it is
    // still refusing.
    if (stale) {
      btn.textContent = "↻ Newer version available — tap to reload";
      btn.addEventListener("click", function () { refresh(btn, files); });
      el.textContent = "";
      el.appendChild(btn);
      // This ships at the foot of the form, which is right for a quiet
      // timestamp and wrong for the one message on the page worth reading —
      // below the fold on a phone, the same failure as the confirmation box
      // in #19.
      if (el.parentNode && el.parentNode.firstElementChild !== el) {
        el.parentNode.insertBefore(el, el.parentNode.firstElementChild);
      }
      return;
    }

    // "Ver:" because a bare date and time at the foot of a page reads as a
    // clock — it looked like the form was telling you what time it was.
    var label = "Ver: web " + (newest ? short(newest) : "unknown");
    el.textContent = "";

    var state = api ? api.state : "unconfigured";

    // Anything other than a working backend has nothing to expand into, and a
    // button that reveals a copy of its own label is worse than no button — so
    // these degrade to plain text rather than a dead control.
    //
    // Not orange, and it does not move to the top of the page. On the one page
    // this badge runs on, the form itself puts a loud notice about the same
    // outage in front of the volunteer, aimed at them and in their words.
    // Stacking a second orange box above it would say the same thing twice to
    // someone who only needed it once. What #61 actually required is that this
    // stop rendering a blank where a fact belongs, and words in grey are not a
    // blank.
    if (state !== "up") {
      if (state === "down") { label += " · api unreachable"; }
      if (state === "unwired") { label += " · api not checked"; }

      var span = document.createElement("span");
      span.className = "version-label";
      span.textContent = label;
      el.appendChild(span);
      return;
    }

    btn.textContent = label;
    btn.setAttribute("aria-expanded", "false");

    var detail = document.createElement("div");
    detail.className = "version-detail";
    detail.hidden = true;
    detail.appendChild(row("web", newest ? short(newest) : "unknown"));
    detail.appendChild(row("api", String(api.version)));

    btn.addEventListener("click", function () {
      detail.hidden = !detail.hidden;
      btn.setAttribute("aria-expanded", detail.hidden ? "false" : "true");
    });

    el.appendChild(btn);
    el.appendChild(detail);
  }

  var assets = ownAssets();
  Promise.all([
    Promise.all(assets.map(checkOne)),
    el.hasAttribute("data-api") ? apiState() : Promise.resolve(null)
  ]).then(function (r) {
    render(r[0], r[1]);
  }).catch(function () {
    // A version badge must never be the reason a page fails to work.
  });
})();
