#!/usr/bin/env python3
"""Build a Mapillary description file for one batch, and check it before you upload.

WHY THIS EXISTS
    Photos submitted through report.html carry no location: phones strip EXIF
    when a photo goes through a web file input. The position lives in the
    Sheet instead, so every upload needs a description file pairing each
    filename with its coordinates. Doing that by hand is tedious and, worse,
    a mismatch puts a photo on the public map at someone else's coordinates
    permanently.

    This does the matching from the submission id embedded in each filename,
    so a photo can only ever be paired with its own row.

USE
    1. Sheet -> File -> Download -> Comma-separated values
    2. Download the batch folder from Drive, e.g. inbox/bwb_south_bay/2026-08-23/
    3. python3 tools/build_desc.py <batch folder> --sheet <that csv>

    It writes desc.json next to the photos and prints the upload command with
    the right organization key already filled in.

IT REFUSES TO BUILD IF
    - any photo's position falls outside that chapter's bounds in config.js
    - a photo has no matching row in the Sheet
    - the folder's chapter disagrees with the Sheet's

    Those are the cases that put imagery somewhere wrong and public, which is
    not undoable. Pass --force to override deliberately.

PHOTOS IT CANNOT USE are reported with a reason rather than failing the run —
    no position recorded, or not a JPEG. Neither can be uploaded by any means,
    and both belong in failed/<chapter>/.
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys

FILENAME_RE = re.compile(
    r'^(?P<y>\d{4})-(?P<mo>\d{2})-(?P<d>\d{2})T'
    r'(?P<h>\d{2})-(?P<mi>\d{2})-(?P<s>\d{2})Z__(?P<sid>[^_]+)__(?P<idx>\d+)\.'
)


def load_config(repo_root):
    """config.js is JavaScript, so let node read it rather than regexing it."""
    script = (
        "const fs=require('fs');"
        "const C=eval(fs.readFileSync(%s,'utf8')+';CONFIG');"
        "console.log(JSON.stringify({accounts:C.accounts}));"
        % json.dumps(os.path.join(repo_root, 'config.js'))
    )
    try:
        out = subprocess.check_output(['node', '-e', script], stderr=subprocess.PIPE)
    except FileNotFoundError:
        sys.exit('error: node is required to read config.js')
    except subprocess.CalledProcessError as e:
        sys.exit('error: could not read config.js\n' + e.stderr.decode())
    return json.loads(out)['accounts']


def chapter_from_path(path):
    """inbox/<chapter>/<date>/ — the chapter is the date folder's parent."""
    parts = os.path.normpath(os.path.abspath(path)).split(os.sep)
    return parts[-2] if len(parts) >= 2 else None


def in_bounds(lat, lon, b):
    return b['west'] <= lon <= b['east'] and b['south'] <= lat <= b['north']


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('folder', help='the batch folder, e.g. ./bwb_south_bay/2026-08-23')
    ap.add_argument('--sheet', required=True, help='CSV export of the submissions sheet')
    ap.add_argument('--out', default=None, help='output path (default: desc.json in the folder)')
    ap.add_argument('--chapter', default=None, help='override the chapter inferred from the path')
    ap.add_argument('--force', action='store_true',
                    help='build anyway despite out-of-bounds photos — think first')
    args = ap.parse_args()

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    accounts = load_config(repo_root)
    by_key = {a['key']: a for a in accounts}

    everything = sorted(
        f for f in os.listdir(args.folder)
        if not f.startswith('.')
        and os.path.isfile(os.path.join(args.folder, f))
        # .json is this tool's own output, under whatever name the operator
        # gave it. Not a submission, so not its business.
        and not f.lower().endswith('.json')
    )
    # mapillary_tools accepts .jpg/.jpeg only (utils.py: IMAGE_EXTENSIONS), so
    # anything else here can never be uploaded by any means. Name it: silently
    # ignoring it leaves the photo sitting in inbox/ forever with nobody told
    # why, which is how the first PNG screenshot got lost.
    photos = [f for f in everything if f.lower().endswith(('.jpg', '.jpeg'))]
    wrong_type = [f for f in everything if f not in photos]

    if not everything:
        sys.exit('error: no photos in %s' % args.folder)

    rows = {}
    with open(args.sheet, newline='', encoding='utf-8-sig') as fh:
        for row in csv.DictReader(fh):
            if row.get('submission_id'):
                rows[row['submission_id'].strip()] = row

    chapter = args.chapter or chapter_from_path(args.folder)
    if chapter not in by_key:
        sys.exit('error: chapter %r is not in config.js (known: %s)'
                 % (chapter, ', '.join(by_key)))
    account = by_key[chapter]
    bounds = account.get('bounds')

    entries, skipped, outside, unmatched, mismatched, already = [], [], [], [], [], []

    for name in photos:
        m = FILENAME_RE.match(name)
        if not m:
            unmatched.append((name, 'filename not in the expected form'))
            continue

        row = rows.get(m.group('sid'))
        if not row:
            unmatched.append((name, 'no row with submission_id %s' % m.group('sid')))
            continue

        # The folder says one chapter and the Sheet says another: that is a
        # misfiled batch, and uploading it would put photos in the wrong org.
        sheet_chapter = (row.get('bwb_chapter') or '').strip()
        if sheet_chapter and sheet_chapter != chapter:
            mismatched.append((name, sheet_chapter))
            continue

        if (row.get('status') or '').strip() == 'uploaded':
            already.append(name)

        lat, lon = (row.get('device_lat') or '').strip(), (row.get('device_lng') or '').strip()
        if not lat or not lon:
            skipped.append((name, 'no position recorded — cannot be placed'))
            continue
        lat, lon = float(lat), float(lon)

        if bounds and not in_bounds(lat, lon, bounds):
            outside.append((name, lat, lon))
            continue

        entries.append({
            'filename': os.path.abspath(os.path.join(args.folder, name)),
            'MAPLatitude': lat,
            'MAPLongitude': lon,
            # The filename stamp is UTC, and MAPCaptureTime is read as UTC.
            'MAPCaptureTime': '%s_%s_%s_%s_%s_%s_000' % (
                m.group('y'), m.group('mo'), m.group('d'),
                m.group('h'), m.group('mi'), m.group('s')),
            'filetype': 'image',
        })

    print('chapter   %s (%s)' % (account['label'], chapter))
    print('org key   %s' % account['organizationId'])
    print('files     %d in folder, %d ready' % (len(everything), len(entries)))

    if wrong_type:
        print('\nnot a JPEG — Mapillary cannot accept these at all: %d'
              % len(wrong_type))
        for name in wrong_type:
            ext = (os.path.splitext(name)[1] or '(none)').lower()
            print('   %s — %s' % (name, ext))
        print('   A .png is almost always an iPhone screenshot rather than a')
        print('   photo. Ask for the original; there is no way to convert one')
        print('   into usable imagery.')
        print('   move these to failed/%s/, status failed, and say so in notes'
              % chapter)

    for label, items in (('skipped (no position)', skipped),
                         ('no matching Sheet row', unmatched)):
        if items:
            print('\n%s: %d' % (label, len(items)))
            for name, why in items:
                print('   %s — %s' % (name, why))
            print('   move these to failed/%s/' % chapter)

    if already:
        print('\nalready marked uploaded in the Sheet: %d' % len(already))
        for name in already:
            print('   %s' % name)
        print('   re-uploading is skipped by mapillary_tools, but check this is intended')

    fatal = False

    if mismatched:
        fatal = True
        print('\nSTOP — these belong to a different chapter than the folder:')
        for name, said in mismatched:
            print('   %s — Sheet says %s, folder says %s' % (name, said, chapter))

    if outside:
        print('\n%s — outside %s:' % ('WARNING' if args.force else 'STOP', account['label']))
        for name, lat, lon in outside:
            print('   %s — %.6f, %.6f' % (name, lat, lon))
        print('   bounds: %s' % json.dumps(bounds))
        if args.force:
            print('   --force given, so these are excluded but the rest will build')
        else:
            fatal = True
            print('   A Mapillary upload is public and permanent. Check the chapter was')
            print('   picked correctly, then move these to failed/%s/ or pass --force.' % chapter)

    if fatal:
        sys.exit(1)

    if not entries:
        sys.exit('\nnothing to upload')

    out_path = args.out or os.path.join(args.folder, 'desc.json')
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(entries, fh, indent=2)
    print('\nwrote %s (%d entries)' % (out_path, len(entries)))

    print('\nNow run:\n')
    print('  python3 %s upload %s \\' % (
        os.path.join('tools', 'mly_upload.py'), args.folder))
    print('    --desc_path %s \\' % out_path)
    print('    --user_name "<your mapillary username>" \\')
    print('    --organization_key "%s"' % account['organizationId'])
    print('\n(That org key is %s\'s, read from config.js — do not retype it.)'
          % account['label'])


if __name__ == '__main__':
    main()
