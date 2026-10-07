#!/usr/bin/env node
/* Unit tests for apps-script/Code.gs.
 *
 * WHY THIS EXISTS
 *     Code.gs cannot be run here — it needs Drive, Sheets and a Google
 *     runtime — so for a long time the only way to find out whether a change
 *     worked was to paste it in, redeploy, and wait for something to go wrong
 *     in the field. That is how a missing scope broke the daily digest for
 *     three days and how a retry stored the same photo three times.
 *
 *     The pure logic does not need any of that. It needs a folder that can be
 *     iterated, a key/value store and a clock, all of which are a dozen lines
 *     of stub. This file supplies them and asserts against the real source.
 *
 * HOW
 *     Code.gs is eval'd, not reimplemented. Its top level is only constant
 *     declarations, so nothing runs and nothing touches the Google runtime
 *     until a function is called. Testing a copy would pass happily while the
 *     file it was copied from rotted.
 *
 * USE
 *     node tools/test_code_gs.js
 */
/* Deliberately NOT in strict mode. A direct eval in strict mode gets its own
 * variable environment, so Code.gs's function declarations would not reach the
 * tests below — they would all fail with ReferenceError on a file that is
 * perfectly fine. Sloppy mode is what lets the real source be loaded as-is. */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'apps-script', 'Code.gs');
eval(fs.readFileSync(SRC, 'utf8'));

/* ------------------------------------------------------------- the runtime */

let store = {};
let handlers = ['dailyDigest', 'scheduledConfirm'];
const refuse = { props: false, triggers: false };

PropertiesService = {
  getScriptProperties: () => {
    if (refuse.props) { throw new Error('no permission'); }
    return {
      setProperty: (k, v) => { store[k] = v; },
      setProperties: o => { Object.assign(store, o); },
      getProperty: k => (k in store ? store[k] : null)
    };
  }
};
ScriptApp = {
  getProjectTriggers: () => {
    if (refuse.triggers) { throw new Error('no permission'); }
    return handlers.map(h => ({ getHandlerFunction: () => h }));
  }
};
Session = { getScriptTimeZone: () => 'America/Los_Angeles' };
Utilities = { formatDate: d => d.toISOString().slice(0, 10) };

function folderOf(names) {
  let i = 0;
  return { getFiles: () => ({
    hasNext: () => i < names.length,
    next: () => { const n = names[i++]; return { getName: () => n, getId: () => 'id:' + n }; }
  })};
}

/* ----------------------------------------------------------------- harness */

let passed = 0, failed = 0;
function is(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log('  ok   ' + label); }
  else {
    failed++;
    console.log('  FAIL ' + label +
      `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
  }
}
function group(name) { console.log('\n' + name); }

const SID = '700fa7fe-dcf2-4d10-97a4-2ac9dbaf5b4b';
const OTHER = 'a757901c-93f0-47da-828e-6471b434f124';

/* ------------------------------------------- existingFile — the #45 dedupe */

group('existingFile (a retry must not store the photo again)');
is('finds an earlier attempt at the same submission and index',
   existingFile(folderOf([`2026-09-28T19-36-24Z__${SID}__1.jpg`]), { submissionId: SID, index: 1 }).getName(),
   `2026-09-28T19-36-24Z__${SID}__1.jpg`);
is('empty folder', existingFile(folderOf([]), { submissionId: SID, index: 1 }), null);
is('a different submission is not a match',
   existingFile(folderOf([`2026-09-28T19-31-41Z__${OTHER}__1.jpg`]), { submissionId: SID, index: 1 }), null);
is('photo 2 is not a match for photo 1',
   existingFile(folderOf([`2026-09-28T19-36-24Z__${SID}__2.jpg`]), { submissionId: SID, index: 1 }), null);
is('index 1 does not match index 11',
   existingFile(folderOf([`2026-09-28T19-36-24Z__${SID}__11.jpg`]), { submissionId: SID, index: 1 }), null);
is('matches whatever the extension is',
   existingFile(folderOf([`2026-09-28T19-36-24Z__${SID}__1.jpeg`]), { submissionId: SID, index: 1 }).getName(),
   `2026-09-28T19-36-24Z__${SID}__1.jpeg`);
is('picks it out of a folder of other reports',
   existingFile(folderOf([
     `2026-09-28T19-31-41Z__${OTHER}__1.jpg`,
     `2026-09-28T19-36-24Z__${SID}__1.jpg`,
     '2026-09-28T19-39-46Z__e6767e4e-62fa-4b50-858c-08171a7e6985__1.jpg'
   ]), { submissionId: SID, index: 1 }).getName(), `2026-09-28T19-36-24Z__${SID}__1.jpg`);

/* ------------------------------------------------ stampsOf — the #45 match */

group('stampsOf (every filename on the row, not just the first)');
is('one file', stampsOf(`2026-09-24T22-53-25Z__${SID}__1.jpg`), ['2026-09-24T22-53-25Z']);
is('the real three-copy row from 2026-09-28',
   stampsOf(`2026-09-28T19-36-24Z__${SID}__1.jpg,2026-09-28T19-36-48Z__${SID}__1.jpg,` +
            `2026-09-28T19-37-51Z__${SID}__1.jpg`),
   ['2026-09-28T19-36-24Z', '2026-09-28T19-36-48Z', '2026-09-28T19-37-51Z']);
is('empty cell', stampsOf(''), []);
is('junk', stampsOf('no stamp here'), []);

/* ------------------------------------------- digest heartbeat — the #46 fix */

group('digestHealth (silence must not read as health)');
store = {};
is('nothing recorded yet', digestHealth(),
   { digestLastCompletedAt: null, digestStaleDays: null, digestOverdue: null,
     triggers: ['dailyDigest', 'scheduledConfirm'],
     headVersion: null, headVersionAt: null });

markDigestRan();
is('after a completed run the age is 0', digestHealth().digestStaleDays, 0);
is('...and the stamp is an ISO timestamp',
   /^\d{4}-\d{2}-\d{2}T/.test(digestHealth().digestLastCompletedAt), true);

store.digestLastCompletedAt = new Date(Date.now() - 7 * 86400000).toISOString();
is('a week old reads as 7 days', digestHealth().digestStaleDays, 7);

handlers = ['dailyDigest'];
is('a deleted trigger disappears from the list', digestHealth().triggers, ['dailyDigest']);
handlers = ['dailyDigest', 'scheduledConfirm'];

refuse.triggers = true;
is('an unreadable trigger list is null, not empty', digestHealth().triggers, null);
refuse.triggers = false;

refuse.props = true;
is('an unreadable store is null, not a date', digestHealth().digestLastCompletedAt, null);
let threw = false;
try { markDigestRan(); } catch (e) { threw = true; }
is('markDigestRan cannot throw', threw, false);
refuse.props = false;

/* ------------------------------- head vs deployed version — the drift check */

group('markHeadVersion (is the editor ahead of /exec?)');
store = {};
markHeadVersion();
is('records the saved project\'s CODE_VERSION', digestHealth().headVersion, CODE_VERSION);
is('...with a timestamp', /^\d{4}-\d{2}-\d{2}T/.test(digestHealth().headVersionAt), true);

store = {};
let confirmRan = false;
const realConfirm = confirmUploads;
confirmUploads = () => { confirmRan = true; };
scheduledConfirm();
is('the trigger wrapper runs the sweep', confirmRan, true);
is('...and stamps the version, so a stale deployment shows up',
   store.headCodeVersion, CODE_VERSION);

// The ordering bug this had on 2026-10-07: the stamp came after the sweep, so
// one throw in confirmUploads blanked the diagnostic exactly when it mattered.
store = {};
confirmUploads = () => { throw new Error('Sheet unavailable'); };
let bubbled = false;
try { scheduledConfirm(); } catch (e) { bubbled = true; }
confirmUploads = realConfirm;
is('a failing sweep still leaves the version stamped', store.headCodeVersion, CODE_VERSION);
is('...and the failure is not swallowed', bubbled, true);

group('digestOverdue (yesterday is fine at 07:00, missed at 11:00)');
const realFormat = Utilities.formatDate;
const atHour = h => { Utilities.formatDate = (d, tz, f) => (f === 'H' ? String(h) : d.toISOString().slice(0, 10)); };
atHour(7);  is('one day old, before the run is due', digestOverdue(1), false);
atHour(11); is('one day old, after the run is due', digestOverdue(1), true);
atHour(7);  is('two days old is overdue at any hour', digestOverdue(2), true);
atHour(23); is('stamped today is never overdue', digestOverdue(0), false);
is('unknown stays unknown', digestOverdue(null), null);
Utilities.formatDate = realFormat;

refuse.props = true;
threw = false;
try { markHeadVersion(); } catch (e) { threw = true; }
is('markHeadVersion cannot throw either', threw, false);
refuse.props = false;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
