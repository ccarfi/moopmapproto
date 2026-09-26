/**
 * MOOP report receiver — Google Apps Script Web App.
 *
 * Serves https://moopmap.org/report.html. Receives one photo per request,
 * files it in Drive under inbox/<chapter>/<date>/, and logs one row per
 * submission in a Sheet. From there, RUNBOOK.md covers batch-uploading to
 * Mapillary.
 *
 * There is no origin check, so the endpoint answers requests from anywhere.
 * That is why moving to a custom domain needed no change here.
 *
 * SETUP
 *   1. script.google.com → New project. Paste this file in as Code.gs.
 *   2. Fill in ROOT_FOLDER_ID and SHEET_ID below.
 *   3. Keep SHARED_TOKEN and CHAPTERS in step with config.js.
 *   4. Deploy → New deployment → Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Copy the /exec URL into CONFIG.upload.endpoint in config.js.
 *   5. Re-deploy (new version) after any edit here — the /exec URL keeps
 *      serving the old code until you do. This is the #1 source of
 *      "why didn't my change take effect".
 *   6. Set ADMIN_TOKEN to something only you know — NOT SHARED_TOKEN — and
 *      put the same value in MOOPMAP_ADMIN_TOKEN where you run the uploads.
 *      Until you do, mark-uploaded and mark-failed are refused.
 *   7. Run installDigestTrigger() once from the editor to get the daily
 *      "reports waiting" email. It will ask to authorize sending mail.
 *
 * NOTE ON SECURITY
 *   SHARED_TOKEN is not security. It ships in client-side JS in a public repo,
 *   so anyone who looks can read it. It deters drive-by bots and nothing more.
 *   This endpoint is open by design until Google auth lands.
 */

// ---------------------------------------------------------------- settings

var ROOT_FOLDER_ID = 'PASTE_DRIVE_FOLDER_ID_HERE';  // the "MoopMap Uploads" folder
var SHEET_ID       = 'PASTE_SHEET_ID_HERE';         // spreadsheet, not a tab name
var SHEET_TAB      = 'submissions';

var SHARED_TOKEN = 'moopmap-v1';                    // must match CONFIG.upload.token

// Must match the keys in CONFIG.accounts. A submission naming anything else is
// rejected: the chapter decides which Mapillary organization the photo is
// eventually uploaded under, so a bad value would misfile it.
//
// KEEP THIS FILE IN STEP WITH THE DEPLOYED SCRIPT. Editing the live script in
// the Apps Script editor without committing the same change here leaves the
// repo copy stale, and the next person who pastes this file over the live one
// silently reverts the allowlist — which drops real submissions on the floor
// with "Unknown chapter". That has happened once already, to bwb_colorado.
// Verify after every deploy:  curl -sL <your /exec URL>
var CHAPTERS = ['bwb_south_bay', 'bwb_colorado', 'bwb_united_kingdom'];

// Mutating actions (mark-uploaded, mark-failed) require this, and it is NOT
// SHARED_TOKEN. SHARED_TOKEN ships in config.js in a public repo, which is
// tolerable while the worst an attacker can do is push junk photos into
// inbox/ for a human to look at. A write path is different: with a public
// token anyone could mark rows uploaded, invent cluster ids or overwrite
// notes, silently corrupting the provenance record.
//
// So this lives here and in the operator's MOOPMAP_ADMIN_TOKEN environment
// variable, and nowhere else. Never commit it.
var ADMIN_TOKEN = 'PASTE_ADMIN_TOKEN_HERE';

// Where the daily digest goes. Left empty on purpose: it defaults to whoever
// owns the trigger, so no email address is committed to a public repo. Set it
// only to send somewhere else.
var NOTIFY_TO = '';

var MAX_BYTES  = 15 * 1024 * 1024;
// One photo per submission. The form sends a single device position and it
// applies to the whole submission, so a second photo taken somewhere else would
// carry a pin that is provably wrong. Enforced here too, because the client can
// be tampered with.
var MAX_PHOTOS = 1;

// Order matters: appendRow writes positionally, so these must match the live
// sheet's columns left to right. 'notes' sits where it already does in the
// sheet; 'mapillary_cluster_id' is appended after it rather than inserted
// before, which would shift every later value into the wrong column.
//
// Both new columns are filled in by a human during the upload run, not by the
// form — see RUNBOOK.md step 5.
var HEADERS = [
  'submission_id', 'bwb_chapter', 'received_at_utc', 'file_names', 'photo_count',
  'device_lat', 'device_lng', 'device_accuracy_m', 'position_source',
  'in_chapter_bounds', 'user_agent', 'status', 'mapillary_uploaded_at',
  'notes', 'mapillary_cluster_id'
];

// -------------------------------------------------------------- endpoints

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) { return fail('Empty request'); }

    var p = JSON.parse(e.postData.contents);

    // Admin actions carry their own token and never touch SHARED_TOKEN.
    if (p.action === 'mark-uploaded' || p.action === 'mark-failed') {
      var denied = adminDenied(p);
      if (denied) { return denied; }
      return p.action === 'mark-uploaded' ? markUploaded(p) : markFailed(p);
    }

    if (p.token !== SHARED_TOKEN)            { return fail('Bad token'); }
    if (p.website)                           { return fail('Rejected'); }   // honeypot
    if (!p.submissionId)                     { return fail('Missing submissionId'); }
    if (CHAPTERS.indexOf(p.bwb_chapter) === -1) { return fail('Unknown chapter'); }
    if (!p.dataBase64)                       { return fail('Missing photo data'); }
    if (p.index > MAX_PHOTOS)                { return fail('Too many photos'); }
    if (p.size && p.size > MAX_BYTES)        { return fail('Photo too large'); }

    var bytes = Utilities.base64Decode(p.dataBase64);
    if (bytes.length > MAX_BYTES) { return fail('Photo too large'); }

    var name = fileName(p);
    var blob = Utilities.newBlob(bytes, p.mimeType || 'image/jpeg', name);
    var file = folderFor(p).createFile(blob);

    recordRow(p, name);

    return ok({ submissionId: p.submissionId, fileId: file.getId(), fileName: name });

  } catch (err) {
    return fail(String(err && err.message ? err.message : err));
  }
}

function doGet() {
  // Handy for confirming a deployment is live without opening the form.
  // adminConfigured is a boolean on purpose — never echo the token itself.
  return ok({
    service: 'moop-report',
    chapters: CHAPTERS,
    adminConfigured: adminDenied({ adminToken: ADMIN_TOKEN }) === null
  });
}

// ----------------------------------------------------------------- drive

// inbox/<chapter>/<YYYY-MM-DD>/ — chapter above date, because each chapter
// uploads under its own Mapillary org key and so has to be batched separately.
function folderFor(p) {
  var root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  return child(child(child(root, 'inbox'), p.bwb_chapter), today());
}

function child(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function today() {
  return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}

function fileName(p) {
  var stamp = Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH-mm-ss'Z'");
  var ext = (String(p.filename || '').match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0];
  return stamp + '__' + p.submissionId + '__' + p.index + ext;
}

// ----------------------------------------------------------------- sheet

// One row per submission. Photos arrive as separate requests, so the first
// creates the row and the rest append their filename to it.
function recordRow(p, name) {
  var sheet = sheetTab();
  var ids = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();

  for (var r = 1; r < ids.length; r++) {
    if (ids[r][0] === p.submissionId) {
      var namesCell = sheet.getRange(r + 1, 4);
      var countCell = sheet.getRange(r + 1, 5);
      var names = String(namesCell.getValue() || '');
      namesCell.setValue(names ? names + ',' + name : name);
      countCell.setValue(Number(countCell.getValue() || 0) + 1);
      return;
    }
  }

  sheet.appendRow([
    p.submissionId,
    p.bwb_chapter,
    new Date().toISOString(),
    name,
    1,
    p.lat != null ? p.lat : '',
    p.lng != null ? p.lng : '',
    p.accuracy != null ? Math.round(p.accuracy) : '',
    p.positionSource || '',
    p.inChapterBounds || 'unknown',
    p.userAgent || '',
    'pending',
    '',   // mapillary_uploaded_at
    '',   // notes
    ''    // mapillary_cluster_id
  ]);
}

function sheetTab() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TAB);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    return sheet;
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    return sheet;
  }
  addMissingHeaders(sheet);
  return sheet;
}

// Adds any header the sheet doesn't have yet, at the end. Deliberately additive:
// it never reorders or renames what's already there, because appendRow writes by
// position and existing rows would silently shift.
function addMissingHeaders(sheet) {
  var width = Math.max(sheet.getLastColumn(), 1);
  var have = sheet.getRange(1, 1, 1, width).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  var missing = HEADERS.filter(function (h) { return have.indexOf(h) === -1; });
  if (!missing.length) { return; }

  sheet.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
}

// ----------------------------------------------------------- write-back

// RUNBOOK.md step 5 asks a human to paste status, timestamp and cluster id per
// row. It does not reliably happen: after two successful upload runs the whole
// mapillary_cluster_id column was still empty. That id is the only durable
// handle joining a Sheet row to what exists on Mapillary — it otherwise lives
// only in ~/Library on whichever machine ran the upload.
function adminDenied(p) {
  if (!ADMIN_TOKEN || ADMIN_TOKEN === 'PASTE_ADMIN_TOKEN_HERE') {
    return fail('Admin actions are not configured on this deployment');
  }
  // Refuse rather than silently accept the public token as an admin token.
  if (ADMIN_TOKEN === SHARED_TOKEN) {
    return fail('ADMIN_TOKEN must not equal SHARED_TOKEN');
  }
  if (!p || p.adminToken !== ADMIN_TOKEN) { return fail('Bad admin token'); }
  return null;
}

function markUploaded(p) {
  if (!p.clusterId) { return fail('Missing clusterId'); }
  var when = p.uploadedAt || new Date().toISOString();

  return applyToRows(p, function (set, get) {
    var already = String(get('mapillary_cluster_id') || '').trim();

    // Never clobber a different cluster id. Two ids on one photo means one of
    // them is wrong, and which is not something this can work out.
    if (already && already !== String(p.clusterId)) {
      return 'conflict: already recorded under cluster ' + already;
    }
    if (already === String(p.clusterId) &&
        String(get('status')).trim() === 'uploaded') {
      return 'unchanged';
    }

    set('status', 'uploaded');
    set('mapillary_uploaded_at', when);
    set('mapillary_cluster_id', String(p.clusterId));
    return 'updated';
  });
}

function markFailed(p) {
  if (!p.reason) { return fail('Missing reason'); }

  return applyToRows(p, function (set, get) {
    var notes = String(get('notes') || '').trim();

    // 'failed' with an empty reason reads as a system fault six months later,
    // which is the whole point of writing one — but an existing note was put
    // there by a person and outranks this.
    if (String(get('status')).trim() === 'failed' && notes) { return 'unchanged'; }

    set('status', 'failed');
    if (!notes) { set('notes', String(p.reason)); }
    return 'updated';
  });
}

// Shared row-walking. Rows are found by submission_id and columns by header
// name — appendRow writes positionally, but addMissingHeaders means the live
// sheet's column order can legitimately differ from HEADERS, and a write to
// the wrong column corrupts the record it is meant to protect.
function applyToRows(p, fn) {
  var ids = p.submissionIds;
  if (!ids || !ids.length) { return fail('Missing submissionIds'); }

  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_TAB);
  if (!sheet) { return fail('No such sheet tab: ' + SHEET_TAB); }

  var values = sheet.getDataRange().getValues();
  var head = values[0].map(function (h) { return String(h).trim(); });
  var iId = head.indexOf('submission_id');
  if (iId === -1) { return fail('Sheet has no submission_id column'); }

  var result = { updated: [], unchanged: [], notFound: [], conflicts: [] };

  ids.forEach(function (id) {
    var rowIndex = -1;
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][iId]).trim() === String(id).trim()) { rowIndex = r; break; }
    }
    // Reported, never swallowed: a typo that silently updates nothing is how
    // you end up believing the Sheet is current when it is not.
    if (rowIndex === -1) { result.notFound.push(id); return; }

    var get = function (name) {
      var c = head.indexOf(name);
      return c === -1 ? '' : values[rowIndex][c];
    };
    var set = function (name, value) {
      var c = head.indexOf(name);
      if (c === -1) { return; }
      sheet.getRange(rowIndex + 1, c + 1).setValue(value);
      values[rowIndex][c] = value;
    };

    var outcome = fn(set, get);
    if (outcome === 'updated')        { result.updated.push(id); }
    else if (outcome === 'unchanged') { result.unchanged.push(id); }
    else                              { result.conflicts.push(id + ' — ' + outcome); }
  });

  return ok(result);
}

// ---------------------------------------------------------------- digest

// Reports only reach the map when a human runs RUNBOOK.md. Nothing otherwise
// says a queue exists, and with chapters submitting into a Drive that is not
// theirs, an unnoticed queue means volunteers abroad see nothing appear and
// conclude the app is broken.
//
// Deliberately a digest and not a per-submission alert: a MOOP walk produces a
// report every couple of minutes, and twenty emails in an hour gets muted — a
// muted notification is indistinguishable from no notification.
//
// Note that Sheets' own notification rules cannot do this job. They do not fire
// for your own edits, and this script runs as the owner, so every row it writes
// is the owner's edit. Such a rule would look configured and do nothing.
function dailyDigest() {
  var rows = pendingRows();

  // Silence has to mean "queue clear", or the mail becomes noise and gets
  // filtered, which is the failure this is meant to prevent.
  if (!rows.length) { return; }

  var uploadable = rows.filter(function (r) { return !r.blocked; });
  var blocked    = rows.filter(function (r) { return r.blocked; });

  var byChapter = {};
  uploadable.forEach(function (r) {
    byChapter[r.chapter] = (byChapter[r.chapter] || 0) + 1;
  });

  var lines = [];
  lines.push(uploadable.length + ' report' + (uploadable.length === 1 ? '' : 's') +
             ' waiting to be uploaded to Mapillary.');
  lines.push('');

  Object.keys(byChapter).sort().forEach(function (k) {
    lines.push('  ' + k + ': ' + byChapter[k]);
  });

  var oldest = oldestAgeDays(uploadable);
  if (oldest !== null) {
    lines.push('');
    lines.push(oldest === 0
      ? 'Oldest arrived today.'
      : 'Oldest has been waiting ' + oldest + ' day' + (oldest === 1 ? '' : 's') + '.');
  }

  // Counted apart so the headline number is work that an upload run can
  // actually clear. These need a 'failed' mark and a note, not an upload.
  if (blocked.length) {
    lines.push('');
    lines.push(blocked.length + (blocked.length === 1 ? ' cannot be uploaded at all and needs'
                                                        : ' cannot be uploaded at all and need') +
               ' marking failed:');
    blocked.forEach(function (r) { lines.push('  ' + r.files + ' — ' + r.why); });
  }

  lines.push('');
  lines.push('Run: RUNBOOK.md');
  lines.push('Sheet: ' + SpreadsheetApp.openById(SHEET_ID).getUrl());

  MailApp.sendEmail(
    recipient(),
    'MOOP Map — ' + uploadable.length + ' report' + (uploadable.length === 1 ? '' : 's') + ' waiting',
    lines.join('\n')
  );
}

// Read by header name rather than by position. appendRow writes positionally,
// but addMissingHeaders means the live sheet's column order can legitimately
// differ from HEADERS — and a digest that reads the wrong column silently
// reports nonsense.
function pendingRows() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_TAB);
  if (!sheet || sheet.getLastRow() < 2) { return []; }

  var values = sheet.getDataRange().getValues();
  var head = values[0].map(function (h) { return String(h).trim(); });
  var col = function (name) { return head.indexOf(name); };

  var iStatus = col('status'), iChapter = col('bwb_chapter'),
      iLat = col('device_lat'), iLng = col('device_lng'),
      iFiles = col('file_names'), iWhen = col('received_at_utc');

  if (iStatus === -1) { return []; }

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (String(row[iStatus]).trim() !== 'pending') { continue; }

    var files = iFiles === -1 ? '' : String(row[iFiles] || '');
    var hasPos = iLat !== -1 && iLng !== -1 &&
                 String(row[iLat]).trim() !== '' && String(row[iLng]).trim() !== '';
    var isJpeg = /\.jpe?g$/i.test(files);

    var why = null;
    if (!hasPos) { why = 'no position recorded'; }
    else if (files && !isJpeg) { why = 'not a JPEG'; }

    out.push({
      chapter: iChapter === -1 ? '(unknown)' : String(row[iChapter] || '(unknown)'),
      files: files,
      when: iWhen === -1 ? '' : String(row[iWhen] || ''),
      blocked: why !== null,
      why: why
    });
  }
  return out;
}

function oldestAgeDays(rows) {
  var oldest = null;
  rows.forEach(function (r) {
    var t = Date.parse(r.when);
    if (!isNaN(t) && (oldest === null || t < oldest)) { oldest = t; }
  });
  if (oldest === null) { return null; }
  return Math.floor((Date.now() - oldest) / 86400000);
}

function recipient() {
  var to = NOTIFY_TO || Session.getEffectiveUser().getEmail();
  if (!to) {
    throw new Error('No digest recipient: set NOTIFY_TO, or run this as a signed-in user.');
  }
  return to;
}

// Idempotent on purpose. Installing from the Triggers UI twice is easy to do
// and leaves you with two digests a day and no obvious cause.
function installDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyDigest') { ScriptApp.deleteTrigger(t); }
  });
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(8).everyDays(1).create();
  return 'Daily digest installed — runs about 08:00 in ' +
         Session.getScriptTimeZone() + ', and stays silent when nothing is pending.';
}

// --------------------------------------------------------------- replies

function ok(obj) {
  obj = obj || {};
  obj.ok = true;
  return json(obj);
}

function fail(message) {
  return json({ ok: false, error: message });
}

function json(obj) {
  // Apps Script cannot set CORS headers. It doesn't need to: report.js posts
  // text/plain, which is a "simple request", so the browser never preflights.
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
