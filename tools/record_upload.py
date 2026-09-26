#!/usr/bin/env python3
"""Record an upload's result in the Sheet, instead of typing it.

WHY THIS EXISTS
    RUNBOOK.md step 5 asks a human to paste status, timestamp and cluster id
    onto every uploaded row. It does not reliably happen — after two
    successful upload runs the entire mapillary_cluster_id column was still
    empty.

    That id matters more than it looks. It is the only durable handle joining
    a Sheet row to what actually exists on Mapillary, and it otherwise lives
    solely in a file under ~/Library on whichever machine ran the upload.

USE
    export MOOPMAP_ADMIN_TOKEN='...'          # never in this repo
    python3 tools/record_upload.py <batch folder>

    Marking things that can never be uploaded:

    python3 tools/record_upload.py <batch folder> \\
        --failed 2026-09-23T14-53-25Z__c0252143__1.png \\
        --reason "PNG screenshot — Mapillary accepts JPEG only"

HOW IT FINDS THE CLUSTER ID
    From mapillary_tools' upload_history, by matching the *set of filenames*
    in that batch's desc.json against each history entry. Not "the newest
    file": two batches uploaded minutes apart would make that wrong, and
    wrong here means a photo recorded against another chapter's sequence.

    Never from the exit code or the summary. mapillary_tools 0.14.7 reports
    "0 Bytes uploaded" on a fully successful run — see RUNBOOK.md. A
    cluster_id is the only evidence the sequence was registered.
"""

import argparse
import glob
import json
import os
import re
import sys
import urllib.request

HISTORY = os.path.expanduser(
    '~/Library/Application Support/mapillary_tools/upload_history')

# 2026-09-24T22-53-25Z__<submission id>__1.jpg
FILENAME_RE = re.compile(r'__(?P<sid>[0-9a-fA-F-]{36})__\d+\.')


def submission_id(path):
    m = FILENAME_RE.search(os.path.basename(path))
    return m.group('sid') if m else None


def endpoint(repo_root):
    """Read the /exec URL from config.js, so it can't drift from the app."""
    with open(os.path.join(repo_root, 'config.js'), encoding='utf-8') as fh:
        m = re.search(r'https://script\.google\.com/macros/s/[^"\']+', fh.read())
    if not m:
        sys.exit('error: no Apps Script endpoint found in config.js')
    return m.group(0)


def post(url, payload):
    body = json.dumps(payload).encode('utf-8')
    # text/plain keeps this a "simple request" — the Apps Script cannot set
    # CORS headers, and this matches what report.js already sends.
    req = urllib.request.Request(url, data=body,
                                 headers={'Content-Type': 'text/plain'})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode('utf-8'))


def cluster_for(desc_path):
    """Match this batch's filenames against an upload_history entry."""
    with open(desc_path, encoding='utf-8') as fh:
        want = set(os.path.basename(d['filename']) for d in json.load(fh))
    if not want:
        sys.exit('error: %s has no entries' % desc_path)

    hits = []
    for f in glob.glob(os.path.join(HISTORY, '*', '*.json')):
        try:
            with open(f, encoding='utf-8') as fh:
                d = json.load(fh)
        except (ValueError, OSError):
            continue
        got = set(os.path.basename(x.get('filename', ''))
                  for x in d.get('descs', []))
        cluster = (d.get('summary') or {}).get('cluster_id')
        if cluster and want <= got:
            hits.append((cluster, d, f))

    if not hits:
        sys.exit('error: no upload_history entry covers these %d files.\n'
                 '       Either the upload has not run, or it did not finish —\n'
                 '       no cluster_id means Mapillary did not register it.'
                 % len(want))
    if len({h[0] for h in hits}) > 1:
        sys.exit('error: these files appear under more than one cluster: %s\n'
                 '       Refusing to guess which one to record.'
                 % ', '.join(sorted({h[0] for h in hits})))
    return hits[0][0], hits[0][1]


def report(res):
    if not res.get('ok'):
        sys.exit('server said: %s' % res.get('error'))
    for label in ('updated', 'unchanged', 'notFound', 'conflicts'):
        items = res.get(label) or []
        if items:
            print('%-10s %d' % (label, len(items)))
            for i in items:
                print('   %s' % i)
    # A conflict or a missing row means the Sheet is not what you think it is.
    if res.get('notFound') or res.get('conflicts'):
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('folder', help='the batch folder that was uploaded')
    ap.add_argument('--desc', default=None, help='desc.json (default: in the folder)')
    ap.add_argument('--failed', nargs='+', metavar='FILE',
                    help='filenames that can never be uploaded')
    ap.add_argument('--reason', help='why, recorded in the notes column')
    ap.add_argument('--dry-run', action='store_true',
                    help='show what would be sent, send nothing')
    args = ap.parse_args()

    token = os.environ.get('MOOPMAP_ADMIN_TOKEN')
    if not token:
        sys.exit('error: set MOOPMAP_ADMIN_TOKEN (it is not the token in config.js,\n'
                 '       and it must never be committed)')

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    url = endpoint(repo_root)

    if args.failed:
        if not args.reason:
            sys.exit('error: --failed needs --reason. "failed" with no reason reads\n'
                     '       as a system fault when someone looks back in six months.')
        ids = [submission_id(f) for f in args.failed]
        missing = [f for f, i in zip(args.failed, ids) if not i]
        if missing:
            sys.exit('error: no submission id in: %s' % ', '.join(missing))
        payload = {'action': 'mark-failed', 'adminToken': token,
                   'submissionIds': ids, 'reason': args.reason}
        print('mark-failed  %d row(s) — %s' % (len(ids), args.reason))
    else:
        desc_path = args.desc or os.path.join(args.folder, 'desc.json')
        if not os.path.exists(desc_path):
            sys.exit('error: no desc.json at %s — run build_desc.py first' % desc_path)

        cluster, hist = cluster_for(desc_path)
        with open(desc_path, encoding='utf-8') as fh:
            ids = [submission_id(d['filename']) for d in json.load(fh)]
        if not all(ids):
            sys.exit('error: some filenames carry no submission id')

        end = (hist.get('summary') or {}).get('upload_end_time')
        when = None
        if end:
            import datetime
            when = datetime.datetime.utcfromtimestamp(end).strftime(
                '%Y-%m-%dT%H:%M:%SZ')

        payload = {'action': 'mark-uploaded', 'adminToken': token,
                   'submissionIds': ids, 'clusterId': cluster, 'uploadedAt': when}
        print('cluster      %s' % cluster)
        print('images       %s in this sequence' %
              (hist.get('summary') or {}).get('sequence_image_count'))
        print('mark-uploaded %d row(s)' % len(ids))

    if args.dry_run:
        safe = dict(payload); safe['adminToken'] = '***'
        print('\n--dry-run, sending nothing:\n' + json.dumps(safe, indent=2))
        return

    print()
    report(post(url, payload))


if __name__ == '__main__':
    main()
