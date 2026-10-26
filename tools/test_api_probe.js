#!/usr/bin/env node
/* Unit tests for api-probe.js.
 *
 * WHY THIS EXISTS
 *     This file decides whether a volunteer gets warned off a form that does
 *     not work, and it is the one new piece of code that can do real damage by
 *     being wrong in either direction. Saying "down" when the endpoint is fine
 *     costs a report. Saying nothing when it is dead costs a photo that cannot
 *     be retaken — which is what #61 was.
 *
 *     So every test below is about a failure path, and about which failures are
 *     allowed to speak.
 *
 * HOW
 *     api-probe.js is eval'd, not reimplemented, same as test_code_gs.js. Its
 *     top level only declares the module, so nothing runs until probe() is
 *     called, and a stubbed fetch is all it needs.
 *
 * USE
 *     node tools/test_api_probe.js
 */
/* Deliberately NOT in strict mode: a direct eval in strict mode gets its own
 * variable environment, so `var MOOPMAP_API` would not reach the tests. */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'api-probe.js');
const SOURCE = fs.readFileSync(SRC, 'utf8');

/* ------------------------------------------------------------- the runtime */

// Real waiting would make the retry tests take seconds apiece for nothing.
global.setTimeout = fn => { fn(); };

let calls = [];          // every fetch the module made
let replies = [];        // queued, one per call; the last one repeats

function reply(spec) { return Object.assign({ ok: true, status: 200 }, spec); }

global.fetch = (url, opts) => {
  calls.push({ url, opts });
  const spec = replies.length > 1 ? replies.shift() : replies[0];
  if (!spec) { throw new Error('test queued no reply'); }
  if (spec.reject) { return Promise.reject(new TypeError('Load failed')); }
  return Promise.resolve({
    ok: spec.ok,
    status: spec.status,
    text: () => Promise.resolve(spec.body)
  });
};

const GOOD = reply({ body: JSON.stringify({ ok: true, version: '2026-10-16.2' }) });

// A fresh module per test: probe() caches, which is the point of it, and a
// cache shared between tests would make them lie to each other.
function load(opts) {
  const o = opts || {};
  calls = [];
  replies = o.replies || [GOOD];
  if (o.endpoint === undefined) {
    global.CONFIG = { upload: { endpoint: 'https://script.google.com/macros/s/AAA/exec' } };
  } else if (o.endpoint === null) {
    delete global.CONFIG;
  } else {
    global.CONFIG = { upload: { endpoint: o.endpoint } };
  }
  return eval(SOURCE + '\n;MOOPMAP_API');
}

/* --------------------------------------------------------------- the tests */

let pass = 0, fail = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else {
    fail++;
    console.log(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
}

function truthy(name, got, why) {
  if (got) { pass++; } else {
    fail++;
    console.log(`FAIL  ${name}\n      ${why}`);
  }
}

async function main() {
  let api, r;

  /* --- what counts as configured ------------------------------------- */

  api = load({ endpoint: null });
  r = await api.probe();
  check('no CONFIG at all is unconfigured, not down', r.state, 'unconfigured');
  check('no CONFIG asks nobody', calls.length, 0);

  api = load({ endpoint: 'PASTE_WEB_APP_URL_HERE' });
  r = await api.probe();
  check('a PASTE_ placeholder is unconfigured', r.state, 'unconfigured');
  check('a placeholder asks nobody', calls.length, 0);

  // An old browser that cannot ask has learned nothing, and must not be
  // allowed to warn a volunteer off a form that works perfectly well.
  const realFetch = global.fetch;
  global.fetch = undefined;
  api = load();
  r = await api.probe();
  check('no fetch is unconfigured, never down', r.state, 'unconfigured');
  global.fetch = realFetch;

  /* --- the happy path, which also has to not retry -------------------- */

  api = load();
  r = await api.probe();
  check('a good reply is up', r.state, 'up');
  check('the deployed version is carried through', r.version, '2026-10-16.2');
  check('a good reply is asked for once', calls.length, 1);
  truthy('the request is cache-busted',
         /[?&]_=\d+/.test(calls[0].url),
         `no _= in ${calls[0].url}`);
  check('the cache is bypassed', calls[0].opts.cache, 'no-store');

  /* --- failures that are allowed to speak ---------------------------- */

  // The #61 shape: a cross-origin 403 has no CORS headers, so fetch rejects
  // and there is no status to report. This must still come back as down.
  api = load({ replies: [{ reject: true }] });
  r = await api.probe();
  check('a rejected fetch is down', r.state, 'down');
  check('a rejected fetch has no status to report', r.status, null);
  truthy('a rejected fetch says it could not be reached',
         /could not be reached/.test(r.why), `why was ${JSON.stringify(r.why)}`);

  api = load({ replies: [reply({ ok: false, status: 500, body: '' })] });
  r = await api.probe();
  check('an HTTP 500 is down', r.state, 'down');
  check('the status is kept', r.status, 500);
  truthy('the why names the status', /500/.test(r.why), `why was ${JSON.stringify(r.why)}`);

  // Reachable is not working. A Google sign-in page is a 200 with HTML, and
  // treating any 200 as healthy is how a dead endpoint looks alive.
  api = load({ replies: [reply({ body: '<!DOCTYPE html><title>Sign in</title>' })] });
  r = await api.probe();
  check('a 200 that is not our reply is down', r.state, 'down');
  truthy('it says the answer was wrong, not that nothing answered',
         /not with the report form/.test(r.why), `why was ${JSON.stringify(r.why)}`);

  api = load({ replies: [reply({ body: JSON.stringify({ ok: false, error: 'nope' }) })] });
  r = await api.probe();
  check('our own ok:false is down', r.state, 'down');

  // doGet has always returned a version. One that stops is a deploy of
  // something else, and guessing it is fine would hide exactly that.
  api = load({ replies: [reply({ body: JSON.stringify({ ok: true }) })] });
  r = await api.probe();
  check('ok:true with no version is down', r.state, 'down');

  /* --- the retry, which exists so a blip cannot cost a report --------- */

  api = load({ replies: [{ reject: true }, GOOD] });
  r = await api.probe();
  check('a blip on the first attempt still ends up', r.state, 'up');
  check('and it took two attempts', calls.length, 2);

  api = load({ replies: [{ reject: true }] });
  r = await api.probe();
  check('a real outage is still down after the retry', r.state, 'down');
  check('it retries once, not forever', calls.length, 2);

  /* --- caching: one page load, one question -------------------------- */

  api = load();
  await api.probe();
  await api.probe();
  await api.probe();
  check('three readers ask the endpoint once', calls.length, 1);

  // Two rejections so the first probe exhausts its retry, then a good reply
  // for the recheck — the last queued reply is the one that repeats.
  api = load({ replies: [{ reject: true }, { reject: true }, GOOD] });
  r = await api.probe();
  check('down on load', r.state, 'down');
  r = await api.recheck();
  check('recheck can take the warning back', r.state, 'up');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { process.exit(1); }
}

main();
