#!/usr/bin/env python3
"""Review a batch photo by photo, then upload and record what you chose.

WHY THIS EXISTS
    The CLI path is all-or-nothing. build_desc.py refuses a whole batch if any
    photo falls outside its chapter's bounds, and the only override is --force,
    which suppresses the check for everything in it. Forcing a batch of twenty
    to publish nineteen good ones is exactly how a bad photo goes public.

    A grid makes that a per-photo decision, which is something the command line
    cannot express.

USE
    export MOOPMAP_ADMIN_TOKEN='...'
    python3 tools/console.py <batch folder> --sheet <submissions.csv>

    Opens http://127.0.0.1:8777 . Review, press Upload, and the Sheet is
    written for you.

WHAT IT DOES NOT DO
    Bind to anything but localhost. It holds the admin token and can publish
    to Mapillary; it must not be reachable from anywhere else.

    Put the token in the page. It stays server-side, used only when talking to
    the Apps Script.

    Move folders in Drive. That needs the move-batch action (see the issue);
    until then the console tells you what to move.
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


def build_batch(folder, rows, chapter_override):
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

    return {'ok': True, 'steps': out, 'moved': do_moves(failures)}


def do_moves(failures):
    """File what could not be uploaded, then take the batch out of the queue.

    No confirmation on either: both are undoable and happen every run, and a
    prompt here would train the reflex that gets the upload confirmation
    clicked through too.
    """
    batch = STATE['batch']
    date = os.path.basename(batch['folder'].rstrip(os.sep))
    done = []

    if failures:
        res = drive_call('move-batch', chapter=batch['chapter'], date=date,
                         to='failed', files=[f['name'] for f in failures])
        done.append({'to': 'failed', 'result': res})

    res = drive_call('move-batch', chapter=batch['chapter'], date=date,
                     to='uploaded')
    done.append({'to': 'uploaded', 'result': res})
    return done


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
            return self._send(200, STATE['batch'])

        if path.startswith('/photo/'):
            name = urllib.parse.unquote(path[len('/photo/'):])
            # Only names the batch actually contains — no traversal.
            if name not in {p['name'] for p in STATE['batch']['photos']}:
                return self._send(404, {'error': 'unknown photo'})
            full = os.path.join(STATE['batch']['folder'], name)
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


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('folder', nargs='?', default=None,
                    help='the batch folder to review')
    ap.add_argument('--list', action='store_true',
                    help="print what is still in Drive's inbox/ and exit")
    ap.add_argument('--move', nargs=3, metavar=('CHAPTER', 'DATE', 'TO'),
                    help='move one batch out of inbox/ into uploaded/ or failed/')
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

    # --list only reads Drive, so it must not ask for a Mapillary account.
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

    if args.batch:
        chapter, date = args.batch
        folder = os.path.join(args.cache_dir, chapter, date)
        print('fetching inbox/%s/%s from Drive' % (chapter, date))
        fetch_batch(chapter, date, folder)
        print('  -> %s' % folder)
        rows = rows_from_sheet()
        print('read %d row(s) from the Sheet' % len(rows))
    elif args.folder:
        folder = os.path.abspath(args.folder)
        # A CSV still works, but live rows are the default: an export goes
        # stale the moment anyone touches the Sheet.
        rows = rows_from_csv(args.sheet) if args.sheet else rows_from_sheet()
    else:
        sys.exit('error: use --batch CHAPTER DATE, or give a folder, '
                 'or use --list / --move')

    user = args.user_name or os.environ.get('MAPILLARY_USER')
    if not user:
        sys.exit('error: pass --user-name or set MAPILLARY_USER (your Mapillary\n'
                 '       account, the one `mapillary_tools authenticate` used)')
    STATE['user_name'] = user
    chapter_hint = args.chapter or (args.batch[0] if args.batch else None)
    STATE['batch'] = build_batch(folder, rows, chapter_hint)

    counts = {}
    for p in STATE['batch']['photos']:
        counts[p['state']] = counts.get(p['state'], 0) + 1
    print('%s — %d photo(s): %s' % (
        STATE['batch']['label'], len(STATE['batch']['photos']),
        ', '.join('%d %s' % (v, k) for k, v in sorted(counts.items()))))

    # 127.0.0.1 explicitly, never 0.0.0.0: this process holds the admin token
    # and can publish publicly. There is no version of this that should be
    # reachable from the network.
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    if server.server_address[0] != '127.0.0.1':
        sys.exit('error: refusing to serve on %s' % server.server_address[0])

    url = 'http://127.0.0.1:%d/' % args.port
    print('review at %s   (ctrl-c when done)' % url)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')


if __name__ == '__main__':
    main()
