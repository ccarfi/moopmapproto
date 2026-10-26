#!/usr/bin/env python3
"""Is the report form's endpoint actually answering?

WHY THIS EXISTS
    On 2026-10-21 the Apps Script Web App stopped serving. The OAuth consent
    screen was in "Testing" publishing status, which issues refresh tokens that
    expire after seven days, so the owner's grant lapsed and every anonymous
    request got a 403. The form was dead for four days.

    Nothing noticed. The daily digest runs inside Apps Script, where the front
    door always looks open. The heartbeat watches the triggers, not the web
    app. `console.py --check` would have printed the warning on 22 October, but
    it only speaks when an operator runs it, and nobody had reason to. The
    outage was found by a volunteer walking a creek and losing two photographs.

    This is the piece that looks from outside, on a schedule, with nobody
    asking. See issue #61.

WHAT IT CHECKS
    Both halves, because the 403 hit both and a form that can read but not
    write is still a broken form:

      doGet   answers 200 with ok:true and a non-empty organization list
      doPost  reaches our code and rejects a bad token

    The second matters more than it looks. Anything can return a 200 page; only
    our own script replies "Bad token". It proves the script ran, not merely
    that Google answered.

WHAT IT NEEDS
    Nothing. The endpoint is public by design and the Mapillary token in
    config.js is a read-only client token, also public by design. No secrets,
    which is why this can run anywhere.

USE
    python3 tools/probe_endpoint.py          # exits non-zero if the form is down
"""

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIMEOUT = 45


def endpoint():
    with open(os.path.join(REPO, 'config.js'), encoding='utf-8') as fh:
        m = re.search(r'https://script\.google\.com/[^"\']+', fh.read())
    if not m:
        die('no Apps Script endpoint in config.js', 'Has CONFIG.upload.endpoint been removed?')
    return m.group(0)


def expected_orgs():
    """The organizations config.js believes in, read by node rather than regex.

    The point is to catch one going missing from the server's allowlist, which
    is how bwb_colorado once disappeared without anyone noticing.
    """
    script = ('const fs=require("fs");'
              'const C=new Function(fs.readFileSync(%r,"utf8")+"; return CONFIG;")();'
              'console.log(C.accounts.map(a=>a.key).join(","));'
              % os.path.join(REPO, 'config.js'))
    try:
        out = subprocess.run(['node', '-e', script], capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None          # no node: skip this check rather than fail on it
    if out.returncode != 0:
        return None
    return [k for k in out.stdout.decode().strip().split(',') if k]


def die(headline, *lines):
    print('FAIL  ' + headline)
    for l in lines:
        print('      ' + l)
    sys.exit(1)


def explain(status):
    """What a status code most likely means here, rather than a bare number."""
    if status == 403:
        return ('The Web App is refusing anonymous requests. Two causes, both seen:',
                '  - Deploy > Manage deployments > Who has access is not "Anyone".',
                '  - The owner\'s OAuth grant lapsed. If the consent screen is back',
                '    in "Testing" status its tokens expire every 7 days (#61).',
                'Re-authorize from the Apps Script editor, then redeploy.')
    if status in (404, 500, 502, 503):
        return ('Google returned %d. If this persists, confirm the deployment still'
                % status,
                'exists and that config.js points at its /exec URL.')
    return ('Unexpected status %d.' % status,)


def call(url, data=None):
    req = urllib.request.Request(
        url, data=data, headers={'Content-Type': 'text/plain'}) if data else url
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        die('the endpoint answered %d' % e.code, *explain(e.code))
    except Exception as e:                                  # noqa: BLE001
        die('could not reach the endpoint: %s' % e,
            'Network failure, or Apps Script is not serving at all.')


def main():
    url = endpoint()
    print('endpoint  %s...' % url[:58])

    # --- doGet: does it answer, and does it still know every organization?
    status, body = call(url)
    try:
        got = json.loads(body)
    except ValueError:
        die('doGet returned %d but the body is not JSON' % status,
            'Usually a Google sign-in or error page, which means the request',
            'never reached the script. First 120 chars:', repr(body[:120]))

    if not got.get('ok'):
        die('doGet answered, but not ok', json.dumps(got)[:200])

    orgs = got.get('chapters') or []
    if not orgs:
        die('doGet reports no organizations at all', 'CHAPTERS in Code.gs is empty.')
    print('doGet     ok   version %s, %d organizations' % (got.get('version'), len(orgs)))

    want = expected_orgs()
    if want:
        missing = [k for k in want if k not in orgs]
        if missing:
            die('the server does not know: %s' % ', '.join(missing),
                'config.js offers these in the form but CHAPTERS in Code.gs does not',
                'list them, so anyone choosing one loses their photo to',
                '"Unknown organization". Paste Code.gs and deploy a new version.')
        print('orgs      ok   server and config.js agree (%s)' % ', '.join(want))

    # --- doPost: the path the form actually uses. A deliberately bad token, so
    #     this is rejected before doPost touches Drive or the Sheet.
    status, body = call(url, json.dumps({
        'token': 'endpoint-probe-not-a-real-token',
        'probe': True,
    }).encode('utf-8'))
    try:
        got = json.loads(body)
    except ValueError:
        die('doPost returned %d but the body is not JSON' % status, repr(body[:120]))

    if got.get('ok') is not False or 'token' not in str(got.get('error', '')).lower():
        die('doPost did not reject the probe token as expected',
            'Expected {"ok":false,"error":"Bad token"}; got: %s' % json.dumps(got)[:160],
            'Something is answering, but it may not be our script.')
    print('doPost    ok   reached the script and rejected the probe token')

    print('\nThe report form is up.')


if __name__ == '__main__':
    main()
