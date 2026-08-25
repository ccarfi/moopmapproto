/**
 * MOOP report receiver — Google Apps Script Web App.
 *
 * Receives one photo per request from report.html, files it in Drive under
 * inbox/<chapter>/<date>/, and logs one row per submission in a Sheet.
 * From there, RUNBOOK.md covers batch-uploading to Mapillary.
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
var CHAPTERS = ['bwb_south_bay'];

var MAX_BYTES  = 15 * 1024 * 1024;
var MAX_PHOTOS = 10;

var HEADERS = [
  'submission_id', 'bwb_chapter', 'received_at_utc', 'file_names', 'photo_count',
  'device_lat', 'device_lng', 'device_accuracy_m', 'position_source',
  'in_chapter_bounds', 'user_agent', 'status', 'mapillary_uploaded_at'
];

// -------------------------------------------------------------- endpoints

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) { return fail('Empty request'); }

    var p = JSON.parse(e.postData.contents);

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
  return ok({ service: 'moop-report', chapters: CHAPTERS });
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
    ''
  ]);
}

function sheetTab() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TAB);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
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
