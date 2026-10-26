/* Is the thing that receives photos actually answering?
 *
 * WHY THIS EXISTS
 *     On 2026-10-25 two reports failed in a park, seven minutes apart, and the
 *     photos were gone. /exec had been returning 403 for days. The order of
 *     events on the phone was: pick an organization, take a photo, wait up to
 *     thirty seconds for a GPS fix, press Send, fail, retry, fail. Every one of
 *     those steps happened after the answer was already knowable (#61).
 *
 *     So ask on load, before any of it is spent.
 *
 * WHAT A BROWSER CAN AND CANNOT SEE
 *     Almost nothing. A cross-origin 403 carries no CORS headers, so fetch
 *     rejects outright and there is no status to read — `Load failed` in
 *     WebKit, `Failed to fetch` in Chrome, and that is the whole of it. A
 *     reachable server that answers wrongly is the only failure this can
 *     actually describe.
 *
 *     That is a reason to be vague, not a reason to be silent. "Down" here
 *     honestly means "could not get an answer", which also covers a phone with
 *     no signal. Callers that face a volunteer must phrase it that way, and
 *     must not claim to know whose fault it is.
 *
 * WHY IT RETRIES, AND WHY IT NEVER BLOCKS
 *     A false alarm costs a report. If this says the server is unreachable
 *     when it is merely slow, and a volunteer believes it and walks away, the
 *     warning did the exact damage it exists to prevent. So: one retry before
 *     saying anything, and callers warn rather than disable. The volunteer is
 *     standing there and may well know better than this file does.
 *
 * ONE PROBE, TWO READERS
 *     The form warns with it and the version badge reports with it. Both want
 *     the same fact about the same endpoint on the same page load, so neither
 *     owns it and neither should ask twice.
 *
 * USE
 *     Load after config.js and before anything that calls it.
 *
 *         MOOPMAP_API.probe().then(function (r) { ... });   // cached
 *         MOOPMAP_API.recheck().then(function (r) { ... }); // asks again
 *
 *     r.state is "up", "down" or "unconfigured".
 *       up            r.version is the deployed CODE_VERSION.
 *       down          r.why is a short phrase for an operator; r.status is the
 *                     HTTP status if there was one, and usually there is not.
 *       unconfigured  CONFIG.upload.endpoint is still a PASTE_ placeholder.
 *                     Not a fault — #setup-warning already covers it.
 */
var MOOPMAP_API = (function () {
  "use strict";

  var RETRY_MS = 1200;

  var pending = null;

  function endpoint() {
    // Guarded rather than assumed: a bare CONFIG that never loaded throws, and
    // this file's whole job is to answer instead of disappearing.
    if (typeof CONFIG === "undefined") { return null; }
    var u = CONFIG && CONFIG.upload && CONFIG.upload.endpoint;
    if (!u || u.indexOf("PASTE_") !== -1) { return null; }
    return u;
  }

  function usable() {
    return typeof fetch === "function" && typeof Promise === "function";
  }

  function bust(url) {
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "_=" + Date.now();
  }

  function down(why, status) {
    return { state: "down", version: null, status: status || null, why: why };
  }

  function attempt(url) {
    return fetch(bust(url), { cache: "no-store" }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (e) { /* not JSON */ }

        if (!res.ok) {
          return down("the server answered HTTP " + res.status, res.status);
        }
        // A 200 that is not our reply means something else is answering for
        // the endpoint — a Google sign-in page, most likely. Reachable is not
        // the same as working, and this is the one case where the difference
        // is visible from here.
        if (!body || !body.ok || !body.version) {
          return down("the server answered, but not with the report form's reply", res.status);
        }
        return { state: "up", version: String(body.version), status: res.status, why: null };
      });
    }).catch(function () {
      // No status, no body, no detail. See WHAT A BROWSER CAN AND CANNOT SEE.
      return down("the server could not be reached", null);
    });
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function run() {
    var url = endpoint();
    if (!url) {
      return Promise.resolve({ state: "unconfigured", version: null,
                               status: null, why: "no endpoint configured" });
    }
    if (!usable()) {
      // An old browser that cannot ask is not evidence of anything. Saying
      // "down" here would warn a volunteer off a form that works.
      return Promise.resolve({ state: "unconfigured", version: null,
                               status: null, why: "this browser cannot probe" });
    }
    return attempt(url).then(function (first) {
      if (first.state === "up") { return first; }
      // Second chance. A 403 will say 403 again and costs one request; a blip
      // on a phone at the edge of signal is the case this is here for.
      return wait(RETRY_MS).then(function () { return attempt(url); });
    });
  }

  return {
    probe: function () {
      if (!pending) { pending = run(); }
      return pending;
    },
    recheck: function () {
      pending = run();
      return pending;
    }
  };
})();
