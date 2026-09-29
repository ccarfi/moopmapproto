#!/usr/bin/env python3
"""MOOP Map Admin — review a batch photo by photo, then upload and record.

WHY THIS EXISTS
    The CLI path is all-or-nothing. build_desc.py refuses a whole batch if any
    photo falls outside its chapter's bounds, and the only override is --force,
    which suppresses the check for everything in it. Forcing a batch of twenty
    to publish nineteen good ones is exactly how a bad photo goes public.

    A grid makes that a per-photo decision, which is something the command line
    cannot express.

USE
    export MOOPMAP_ADMIN_TOKEN='...'          # never in this repo
    export MAPILLARY_USER='<your mapillary username>'
    python3 tools/console.py

    No arguments. It opens http://127.0.0.1:8777 on the queue — what is still
    sitting in Drive's inbox/ — with a Download and review button per batch.
    Start it once and leave it running; a batch is picked, reviewed, uploaded
    and recorded without going back to the terminal.

    MAPILLARY_USER is only needed to upload. Without it reviewing still works
    and startup says so.

    Naming a folder still works for a batch already on disk:

        python3 tools/console.py ./bwb_south_bay/2026-09-24

    One-shot commands that print and exit instead of serving:

        --list                      what is waiting in inbox/
        --check                     run the Mapillary confirmation sweep now
        --move CHAPTER DATE TO      move a batch to uploaded/ or failed/

WHAT IT DOES NOT DO
    Bind to anything but localhost. It holds the admin token and can publish
    to Mapillary; it must not be reachable from anywhere else.

    Put the token in the page. It stays server-side, used only when talking to
    the Apps Script.
"""

import argparse
import html
import http.server
import json
import mimetypes
import os
import socket
import subprocess
import sys
import threading
import urllib.parse
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

# Imported rather than reimplemented: a second copy of the bounds test or the
# filename parsing would drift from the CLI, and the two disagreeing about
# whether a photo is in bounds is the worst possible failure here.
import build_desc
import record_upload

STATE = {}


# ------------------------------------------------------------ classification

def classify(name, row, account, already_uploaded):
    """What this photo is, and whether it should be ticked by default.

    Defaults exist so the ordinary batch is 'glance, press Upload'. The grid
    earns its keep on the exceptions, which is why every one of them arrives
    unticked with a reason attached rather than silently dropped.
    """
    sid = record_upload.submission_id(name)

    if not build_desc.FILENAME_RE.match(name):
        return dict(state='unusable', selected=False, sid=sid,
                    reason='filename is not in the expected form')

    if not name.lower().endswith(('.jpg', '.jpeg')):
        return dict(state='unusable', selected=False, sid=sid,
                    reason='not a JPEG — Mapillary accepts jpg/jpeg only, '
                           'and a .png is almost always a screenshot')

    if row is None:
        return dict(state='unusable', selected=False, sid=sid,
                    reason='no row in the Sheet for submission %s' % sid)

    sheet_chapter = (row.get('bwb_chapter') or '').strip()
    if sheet_chapter and sheet_chapter != account['key']:
        return dict(state='blocked', selected=False, sid=sid,
                    reason='the Sheet says %s, this batch is %s — a misfiled '
                           'batch would upload into the wrong organization'
                           % (sheet_chapter, account['key']))

    lat = (row.get('device_lat') or '').strip()
    lng = (row.get('device_lng') or '').strip()
    if not lat or not lng:
        return dict(state='unusable', selected=False, sid=sid,
                    reason='no position recorded — iOS strips EXIF through a '
                           'web file input, so this cannot be placed at all')

    status = (row.get('status') or '').strip()
    if status in ('uploaded', 'live'):
        return dict(state='done', selected=False, sid=sid, lat=float(lat),
                    lng=float(lng), reason='already %s in the Sheet' % status)

    if sid in already_uploaded:
        return dict(state='unrecorded', selected=False, sid=sid,
                    lat=float(lat), lng=float(lng),
                    cluster=already_uploaded[sid],
                    reason='already on Mapillary under cluster %s but the '
                           'Sheet does not say so — record it rather than '
                           'sending it again' % already_uploaded[sid])

    # The volunteer was shown their phone's position, told the pin disagreed,
    # and kept the pin anyway. Sometimes right — the phone is occasionally the
    # one that is wrong — but never something to publish unlooked-at.
    kept = (row.get('pin_kept_despite_km') or '').strip()
    if kept:
        try:
            km = float(kept)
        except ValueError:
            km = None
        return dict(state='disputed', selected=False, sid=sid,
                    lat=float(lat), lng=float(lng),
                    reason='pin kept %s from where the phone said they were — '
                           'check it before sending'
                           % ('%.1f km' % km if km and km >= 1 else
                              ('%d m' % round((km or 0) * 1000)) if km else 'some way'))

    bounds = account.get('bounds')
    if bounds and not build_desc.in_bounds(float(lat), float(lng), bounds):
        # Not blocked — offered, unticked. This is the decision the CLI could
        # only express as --force over an entire batch.
        return dict(state='outside', selected=False, sid=sid,
                    lat=float(lat), lng=float(lng),
                    reason='outside %s — check the chapter was picked '
                           'correctly before sending this one'
                           % account['label'])

    return dict(state='ready', selected=True, sid=sid,
                lat=float(lat), lng=float(lng), reason=None)


def uploaded_already():
    """Submission ids mapillary_tools has a finished cluster for.

    This is what makes closing the tab mid-run safe: an upload that finished
    without being recorded shows up as 'unrecorded' next time rather than being
    sent again.
    """
    out = {}
    import glob
    for f in glob.glob(os.path.join(record_upload.HISTORY, '*', '*.json')):
        try:
            with open(f, encoding='utf-8') as fh:
                d = json.load(fh)
        except (ValueError, OSError):
            continue
        cluster = (d.get('summary') or {}).get('cluster_id')
        if not cluster:
            continue
        for desc in d.get('descs', []):
            sid = record_upload.submission_id(desc.get('filename', ''))
            if sid:
                out[sid] = cluster
    return out


def rows_from_csv(path):
    import csv
    rows = {}
    with open(path, newline='', encoding='utf-8-sig') as fh:
        for row in csv.DictReader(fh):
            if row.get('submission_id'):
                rows[row['submission_id'].strip()] = row
    return rows


def rows_from_sheet():
    """Live rows, so the review never runs against a stale CSV export."""
    res = drive_call('sheet-rows')
    if not res.get('ok'):
        sys.exit('error reading the Sheet: %s' % res.get('error'))
    return {r['submission_id'].strip(): r
            for r in res.get('rows') or [] if r.get('submission_id')}


def fetch_one(chapter, date, name, size, dest):
    """One file. Per file so the page can show progress and a failure costs
    one photo rather than the batch."""
    os.makedirs(dest, exist_ok=True)
    target = os.path.join(dest, name)
    if os.path.exists(target) and (not size or os.path.getsize(target) == size):
        return {'ok': True, 'cached': True, 'name': name}

    res = drive_call('fetch-file', chapter=chapter, date=date, name=name)
    if not res.get('ok'):
        return {'ok': False, 'name': name, 'error': res.get('error')}

    import base64
    with open(target, 'wb') as fh:
        fh.write(base64.b64decode(res['dataBase64']))
    return {'ok': True, 'cached': False, 'name': name}


def fetch_batch(chapter, date, dest):
    """Pull a batch out of Drive, flat. No zip, so no nested <date>/<date>/."""
    listing = drive_call('list-inbox', chapter=chapter, date=date)
    if not listing.get('ok'):
        sys.exit('error: %s' % listing.get('error'))

    files = listing.get('files') or []
    if not files:
        sys.exit('error: inbox/%s/%s is empty' % (chapter, date))

    os.makedirs(dest, exist_ok=True)
    for i, f in enumerate(files, 1):
        target = os.path.join(dest, f['name'])
        if os.path.exists(target) and os.path.getsize(target) == f.get('size'):
            print('  [%d/%d] %s (already here)' % (i, len(files), f['name']))
            continue
        print('  [%d/%d] %s (%.1f MB)…'
              % (i, len(files), f['name'], (f.get('size') or 0) / 1048576),
              end='', flush=True)
        res = drive_call('fetch-file', chapter=chapter, date=date, name=f['name'])
        if not res.get('ok'):
            sys.exit('\nerror fetching %s: %s' % (f['name'], res.get('error')))
        import base64
        with open(target, 'wb') as fh:
            fh.write(base64.b64decode(res['dataBase64']))
        print(' done')
    return dest


def pick_batch():
    """Work out which batch to review, asking only when it is ambiguous."""
    res = drive_call('list-inbox')
    if not res.get('ok'):
        sys.exit('error: %s' % res.get('error'))
    batches = res.get('batches') or []

    if not batches:
        sys.exit('inbox/ is empty — nothing waiting')

    if len(batches) == 1:
        b = batches[0]
        print('one batch waiting: %s %s (%d photo%s)'
              % (b['chapter'], b['date'], b['files'],
                 '' if b['files'] == 1 else 's'))
        return [b['chapter'], b['date']]

    print('waiting in inbox/:')
    for i, b in enumerate(batches, 1):
        print('  %d) %-20s %-12s %d photo%s'
              % (i, b['chapter'], b['date'], b['files'],
                 '' if b['files'] == 1 else 's'))

    # Nothing is picked for you when there is a choice, and nothing is picked
    # at all without someone to ask.
    if not sys.stdin.isatty():
        sys.exit('\nseveral batches waiting — name one with '
                 '--batch CHAPTER DATE')

    try:
        answer = input('\nreview which? [1-%d, or enter to quit] ' % len(batches))
    except (EOFError, KeyboardInterrupt):
        sys.exit('\nnothing chosen')
    if not answer.strip():
        sys.exit('nothing chosen')
    try:
        b = batches[int(answer) - 1]
        if int(answer) < 1:
            raise ValueError
    except (ValueError, IndexError):
        sys.exit('error: %r is not one of the choices' % answer.strip())
    return [b['chapter'], b['date']]


def build_batch(folder, rows, chapter_override, only=None):
    """`only` is the set of filenames Drive says are in this batch.

    Without it this listed whatever happened to be in the local cache, which
    is not the same thing: a photo fetched earlier and since filed to
    uploaded/ stays on disk forever. That showed seven photos for a batch of
    five, and a grid that does not match the batch is a grid that can send the
    wrong thing.
    """
    accounts = build_desc.load_config(REPO)
    by_key = {a['key']: a for a in accounts}

    chapter = chapter_override or build_desc.chapter_from_path(folder)
    if chapter not in by_key:
        sys.exit('error: chapter %r is not in config.js (known: %s)'
                 % (chapter, ', '.join(by_key)))
    account = by_key[chapter]

    done = uploaded_already()
    photos = []
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if name.startswith('.') or not os.path.isfile(path):
            continue
        if name.lower().endswith('.json'):
            continue
        if only is not None and name not in only:
            continue
        sid = record_upload.submission_id(name)
        info = classify(name, rows.get(sid), account, done)
        info.update(name=name, size=os.path.getsize(path))
        m = build_desc.FILENAME_RE.match(name)
        if m:
            info['captured'] = '%s-%s-%s %s:%s:%s UTC' % (
                m.group('y'), m.group('mo'), m.group('d'),
                m.group('h'), m.group('mi'), m.group('s'))
        row = rows.get(sid) or {}
        info['accuracy'] = (row.get('device_accuracy_m') or '').strip()
        info['source'] = (row.get('position_source') or '').strip()
        photos.append(info)

    return {'chapter': account['key'], 'label': account['label'],
            'org': account['organizationId'], 'bounds': account.get('bounds'),
            'folder': folder, 'photos': photos}


# -------------------------------------------------------------------- upload

def do_upload(names):
    if not STATE.get('user_name'):
        return {'ok': False, 'error': 'No Mapillary account set. Start the '
                'console with --user-name, or set MAPILLARY_USER.'}
    batch = STATE['batch']
    folder = batch['folder']
    chosen = [p for p in batch['photos'] if p['name'] in set(names)]
    if not chosen:
        return {'ok': False, 'error': 'nothing selected'}

    entries = []
    for p in chosen:
        m = build_desc.FILENAME_RE.match(p['name'])
        entries.append({
            'filename': os.path.abspath(os.path.join(folder, p['name'])),
            'MAPLatitude': p['lat'],
            'MAPLongitude': p['lng'],
            'MAPCaptureTime': '%s_%s_%s_%s_%s_%s_000' % (
                m.group('y'), m.group('mo'), m.group('d'),
                m.group('h'), m.group('mi'), m.group('s')),
            'filetype': 'image',
        })

    desc_path = os.path.join(folder, 'desc.json')
    with open(desc_path, 'w', encoding='utf-8') as fh:
        json.dump(entries, fh, indent=2)

    cmd = [sys.executable, os.path.join(HERE, 'mly_upload.py'), 'upload', folder,
           '--desc_path', desc_path,
           '--user_name', STATE['user_name'],
           '--organization_key', batch['org']]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    log = (proc.stdout or '') + (proc.stderr or '')

    # Never trust the exit code or the summary: 0.14.7 reports "0 Bytes
    # uploaded" on a fully successful run. A cluster_id is the only evidence.
    try:
        cluster, _hist = record_upload.cluster_for(desc_path)
    except SystemExit as e:
        return {'ok': False, 'error': str(e), 'log': log}

    return {'ok': True, 'cluster': cluster,
            'names': [p['name'] for p in chosen], 'log': log}


def do_remove(name, reason):
    """Take one submission out of the system.

    The local cached copy goes too. Leaving it behind would mean the next
    person to open this folder sees an image the Sheet says was removed, which
    is exactly the confusion removal is supposed to end.
    """
    if not name:   return {'ok': False, 'error': 'no photo named'}
    if not reason: return {'ok': False, 'error': 'a reason is required'}

    batch = STATE.get('batch') or {}
    photo = next((p for p in batch.get('photos', []) if p['name'] == name), None)
    if not photo:
        return {'ok': False, 'error': 'not in this batch: %s' % name}

    res = drive_call('remove-submission', submissionId=photo['sid'],
                     reason=reason, removedBy='admin')
    if not res.get('ok'):
        return res

    local = os.path.join(batch['folder'], name)
    try:
        if os.path.exists(local):
            os.remove(local)
            res['localDeleted'] = True
    except OSError as e:
        res['localError'] = str(e)

    batch['photos'] = [p for p in batch.get('photos', []) if p['name'] != name]
    return res


def drive_call(action, **kw):
    kw.update(action=action, adminToken=STATE['token'])
    return record_upload.post(record_upload.endpoint(REPO), kw)


def do_record(uploaded_names, cluster, failures):
    url = record_upload.endpoint(REPO)
    token = STATE['token']
    out = []

    if uploaded_names and cluster:
        ids = [record_upload.submission_id(n) for n in uploaded_names]
        res = record_upload.post(url, {
            'action': 'mark-uploaded', 'adminToken': token,
            'submissionIds': ids, 'clusterId': cluster})
        out.append({'action': 'mark-uploaded', 'result': res})

    # Grouped by reason so each row gets the specific one, never an empty note.
    by_reason = {}
    for f in failures:
        sid = record_upload.submission_id(f['name'])
        if sid:
            by_reason.setdefault(f['reason'], []).append(sid)
    for reason, ids in by_reason.items():
        res = record_upload.post(url, {
            'action': 'mark-failed', 'adminToken': token,
            'submissionIds': ids, 'reason': reason})
        out.append({'action': 'mark-failed', 'reason': reason, 'result': res})

    # The Sheet is written before anything moves in Drive. A crash between the
    # two should leave a folder to re-examine, not a cluster id that cannot be
    # reconstructed — it lives only in upload_history on this machine.
    #
    # And a write that did not fully land means the Sheet is not what we think
    # it is, so emptying the queue on top of that would compound it.
    trouble = []
    for step in out:
        r = step.get('result') or {}
        if not r.get('ok'):
            trouble.append('%s: %s' % (step['action'], r.get('error')))
        trouble += list(r.get('conflicts') or [])
        trouble += ['not found: %s' % i for i in (r.get('notFound') or [])]

    if trouble:
        return {'ok': True, 'steps': out, 'moved': None, 'heldBack': trouble}

    moved, leftover = do_moves(failures, uploaded_names)
    return {'ok': True, 'steps': out, 'moved': moved, 'leftover': leftover}


def do_moves(failures, uploaded_names):
    """File what could not be uploaded, then take the batch out of the queue.

    No confirmation on either: both are undoable and happen every run, and a
    prompt here would train the reflex that gets the upload confirmation
    clicked through too.

    The batch only leaves inbox/ when nothing sendable is left in it. Uploading
    a subset and moving the whole folder anyway strands the rest: still pending
    in the Sheet, but no longer in the queue, so the console would never offer
    them again.
    """
    batch = STATE['batch']
    date = os.path.basename(batch['folder'].rstrip(os.sep))
    sent = set(uploaded_names or [])
    done = []

    if failures:
        res = drive_call('move-batch', chapter=batch['chapter'], date=date,
                         to='failed', files=[f['name'] for f in failures])
        done.append({'to': 'failed', 'result': res})

    leftover = [p['name'] for p in batch['photos']
                if p['state'] in ('ready', 'outside') and p['name'] not in sent]
    if leftover:
        return done, leftover

    res = drive_call('move-batch', chapter=batch['chapter'], date=date,
                     to='uploaded')
    done.append({'to': 'uploaded', 'result': res})
    return done, []


# -------------------------------------------------------------------- server

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass

    def _send(self, code, body, ctype='application/json'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode('utf-8')
        elif isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path == '/':
            with open(os.path.join(HERE, 'console.html'), encoding='utf-8') as fh:
                return self._send(200, fh.read(), 'text/html; charset=utf-8')

        if path == '/api/batch':
            # The token is deliberately absent from everything served.
            return self._send(200, STATE.get('batch') or {'empty': True})

        if path == '/api/queue':
            res = drive_call('list-inbox')
            return self._send(200, res)

        if path == '/api/files':
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            res = drive_call('list-inbox', chapter=q.get('chapter', [''])[0],
                             date=q.get('date', [''])[0])
            return self._send(200, res)

        if path.startswith('/photo/'):
            name = urllib.parse.unquote(path[len('/photo/'):])
            # Only names the batch actually contains — no traversal.
            batch = STATE.get('batch') or {'photos': []}
            if name not in {p['name'] for p in batch['photos']}:
                return self._send(404, {'error': 'unknown photo'})
            full = os.path.join(batch['folder'], name)
            ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
            with open(full, 'rb') as fh:
                return self._send(200, fh.read(), ctype)

        return self._send(404, {'error': 'not found'})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        length = int(self.headers.get('Content-Length') or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return self._send(400, {'error': 'bad json'})

        if path == '/api/fetch-one':
            return self._send(200, fetch_one(
                payload.get('chapter'), payload.get('date'),
                payload.get('name'), payload.get('size'),
                os.path.join(STATE['cache'], payload.get('chapter', ''),
                             payload.get('date', ''))))

        if path == '/api/load':
            chapter, date = payload.get('chapter'), payload.get('date')
            folder = os.path.join(STATE['cache'], chapter, date)
            # Drive decides what is in the batch, not the local directory.
            listing = drive_call('list-inbox', chapter=chapter, date=date)
            if not listing.get('ok'):
                return self._send(200, {'ok': False, 'error': listing.get('error')})
            only = set(f['name'] for f in (listing.get('files') or []))
            try:
                STATE['batch'] = build_batch(folder, rows_from_sheet(),
                                             chapter, only)
            except SystemExit as e:
                return self._send(200, {'ok': False, 'error': str(e)})
            return self._send(200, STATE['batch'])

        if path == '/api/remove':
            try:
                return self._send(200, do_remove(payload.get('name'),
                                                 payload.get('reason')))
            except Exception as e:                      # noqa: BLE001
                return self._send(200, {'ok': False, 'error': str(e)})

        if path == '/api/upload':
            try:
                return self._send(200, do_upload(payload.get('names') or []))
            except Exception as e:                      # noqa: BLE001
                return self._send(200, {'ok': False, 'error': str(e)})

        if path == '/api/record':
            try:
                return self._send(200, do_record(
                    payload.get('names') or [], payload.get('cluster'),
                    payload.get('failures') or []))
            except Exception as e:                      # noqa: BLE001
                return self._send(200, {'ok': False, 'error': str(e)})

        return self._send(404, {'error': 'not found'})


def digest_warnings(res):
    """What the digest's heartbeat says, in words rather than raw fields.

    The digest is silent when the queue is clear, on purpose — mail that means
    "you have work" must not become noise. The cost is that silence also means
    "I am broken", and from the outside the two are identical. A missing scope
    made it throw for three days and the only morning in between had an empty
    queue, so it returned early, above the throw, and looked healthy (#46).

    So: it marks each completed run, and the mark going stale is the signal.
    """
    triggers = res.get('triggers')
    when = res.get('digestLastCompletedAt')
    stale = res.get('digestStaleDays')
    out = []

    if triggers is None:
        out.append('Could not read the trigger list. Open Triggers in the Apps Script\n'
                   'editor and check by hand.')
    else:
        for fn, so_what in (
                ('dailyDigest', 'nothing will mail you when\nreports are waiting'),
                ('confirmUploads', 'nothing will move uploaded\nrows to live')):
            if fn not in triggers:
                out.append('No %s trigger is installed, so %s.\n'
                           'Run installDigestTrigger() in the Apps Script editor.'
                           % (fn, so_what))

    if not when:
        out.append('The digest has never recorded a completed run. If it was installed\n'
                   'more than a day ago it is failing — open Executions in the Apps\n'
                   'Script editor and read the dailyDigest error.')
    elif stale is not None and stale >= 2:
        out.append('The digest last completed %s, %d days ago. It runs daily, so it is\n'
                   'failing or disabled — open Executions in the Apps Script editor and\n'
                   'read the dailyDigest error.' % (when[:10], stale))

    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('folder', nargs='?', default=None,
                    help='the batch folder to review')
    ap.add_argument('--list', action='store_true',
                    help="print what is still in Drive's inbox/ and exit")
    ap.add_argument('--move', nargs=3, metavar=('CHAPTER', 'DATE', 'TO'),
                    help='move one batch out of inbox/ into uploaded/ or failed/')
    ap.add_argument('--check', action='store_true',
                    help='run the Mapillary confirmation now and report what it saw')
    ap.add_argument('--batch', nargs=2, metavar=('CHAPTER', 'DATE'),
                    help='fetch this batch from Drive and review it — no '
                         'download, no unzip, no CSV export')
    ap.add_argument('--cache-dir',
                    default=os.path.expanduser('~/.moopmap/batches'),
                    help='where fetched batches are kept')
    ap.add_argument('--sheet', help='CSV export of the submissions sheet')
    ap.add_argument('--chapter', default=None, help='override the chapter inferred from the path')
    ap.add_argument('--user-name', default=None, help='Mapillary username (default: $MAPILLARY_USER)')
    ap.add_argument('--port', type=int, default=8777)
    ap.add_argument('--no-browser', action='store_true')
    args = ap.parse_args()

    token = os.environ.get('MOOPMAP_ADMIN_TOKEN')
    if not token:
        sys.exit('error: set MOOPMAP_ADMIN_TOKEN — the console records results\n'
                 '       in the Sheet, and that is not the token in config.js')

    STATE['token'] = token
    STATE['user_name'] = args.user_name or os.environ.get('MAPILLARY_USER')

    # --list only reads Drive, so it must not ask for a Mapillary account.
    if args.check:
        res = drive_call('confirm-now', chapter=args.chapter or 'bwb_south_bay')
        if not res.get('ok'):
            sys.exit('error: %s' % res.get('error'))
        print(json.dumps({k: v for k, v in res.items() if k != 'ok'}, indent=2))
        # A boolean in the middle of that dump is easy to skim past, and this
        # one means the /exec URL is not serving what is in the editor — which
        # makes every other number above describe code you are not running.
        if res.get('editedSinceStamp'):
            print('\nWARNING: the script was last saved %s, after CODE_VERSION was\n'
                  '         stamped %s. The /exec URL still serves the older\n'
                  '         code. Deploy > Manage deployments > edit > New version,\n'
                  '         and bump CODE_VERSION while you are in there.'
                  % ((res.get('scriptUpdated') or '?')[:10], res.get('codeVersion')))
        for warning in digest_warnings(res):
            print('\nWARNING: ' + warning.replace('\n', '\n         '))
        return

    if args.list:
        res = drive_call('list-inbox')
        if not res.get('ok'):
            sys.exit('error: %s' % res.get('error'))
        batches = res.get('batches') or []
        if not batches:
            print('inbox/ is empty — nothing waiting')
            return
        print('waiting in inbox/:')
        for b in batches:
            print('  %-20s %-12s %d photo%s'
                  % (b['chapter'], b['date'], b['files'],
                     '' if b['files'] == 1 else 's'))
        return

    # For batches the console did not upload itself — anything finished before
    # move-batch existed, which is how inbox/ drifts out of step with the Sheet.
    if args.move:
        chapter, date, to = args.move
        res = drive_call('move-batch', chapter=chapter, date=date, to=to)
        if not res.get('ok'):
            sys.exit('error: %s' % res.get('error'))
        print('moved %s -> %s' % (date, res.get('to')))
        return

    STATE['cache'] = args.cache_dir

    # No arguments: start with no batch and let the page show the queue. The
    # terminal step is then a one-off — start it and leave it running — rather
    # than something repeated for every batch.
    if not args.batch and not args.folder:
        STATE['batch'] = None
        res = drive_call('list-inbox')
        n = len(res.get('batches') or []) if res.get('ok') else 0
        print('%d batch(es) waiting in inbox/' % n if res.get('ok')
              else 'could not reach Drive: %s' % res.get('error'))
        return serve(args)

    if args.batch:
        chapter, date = args.batch
        folder = os.path.join(args.cache_dir, chapter, date)
        print('fetching inbox/%s/%s from Drive' % (chapter, date))
        fetch_batch(chapter, date, folder)
        print('  -> %s' % folder)
        rows = rows_from_sheet()
        print('read %d row(s) from the Sheet' % len(rows))
    else:
        folder = os.path.abspath(args.folder)
        # A CSV still works, but live rows are the default: an export goes
        # stale the moment anyone touches the Sheet.
        rows = rows_from_csv(args.sheet) if args.sheet else rows_from_sheet()



    chapter_hint = args.chapter or (args.batch[0] if args.batch else None)
    STATE['batch'] = build_batch(folder, rows, chapter_hint)

    counts = {}
    for p in STATE['batch']['photos']:
        counts[p['state']] = counts.get(p['state'], 0) + 1
    print('%s — %d photo(s): %s' % (
        STATE['batch']['label'], len(STATE['batch']['photos']),
        ', '.join('%d %s' % (v, k) for k, v in sorted(counts.items()))))

    serve(args)


def serve(args):
    # 127.0.0.1 explicitly, never 0.0.0.0: this process holds the admin token
    # and can publish publicly. There is no version of this that should be
    # reachable from the network.
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    if server.server_address[0] != '127.0.0.1':
        sys.exit('error: refusing to serve on %s' % server.server_address[0])

    if not STATE.get('user_name'):
        print('note: MAPILLARY_USER is not set — reviewing works, uploading '
              'will not')

    url = 'http://127.0.0.1:%d/' % args.port
    print('MOOP Map Admin: %s   (leave this running; ctrl-c to stop)' % url)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')


if __name__ == '__main__':
    main()
