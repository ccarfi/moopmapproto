#!/usr/bin/env python3
"""Unit tests for tools/probe_endpoint.py.

WHY THIS EXISTS
    The probe's whole job is to fail, loudly and usefully, on a day nobody is
    watching. The success path is the easy half and proves almost nothing: a
    probe that cannot fail correctly is worse than none, because it is a green
    light wired to nothing.

    So these tests are all about the failures — that each one is caught, and
    that the message names the remedy rather than a status code.

USE
    python3 tools/test_probe.py
"""

import importlib.util
import io
import json
import os
import sys
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('probe', os.path.join(HERE, 'probe_endpoint.py'))
probe = importlib.util.module_from_spec(spec)
sys.modules['probe'] = probe
spec.loader.exec_module(probe)

OK_GET = {'service': 'moop-report', 'version': '2026-10-16.2', 'ok': True,
          'chapters': ['bwb_south_bay', 'kccb']}
OK_POST = {'ok': False, 'error': 'Bad token'}


class Resp:
    def __init__(self, body, status=200):
        self.status, self._b = status, body.encode()
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False


def run(get=None, post=None, raises=None, orgs=('bwb_south_bay', 'kccb')):
    """Run the probe against a stubbed server; return (exit_code, output)."""
    calls = {'n': 0}

    def fake_urlopen(req, timeout=None):
        calls['n'] += 1
        if raises and calls['n'] == 1:
            raise raises
        is_post = not isinstance(req, str) and req.data is not None
        return Resp(post if is_post else get)

    probe.urllib.request.urlopen = fake_urlopen
    probe.expected_orgs = lambda: list(orgs)
    probe.endpoint = lambda: 'https://script.google.com/macros/s/PROBE/exec'

    buf, real = io.StringIO(), sys.stdout
    sys.stdout = buf
    code = 0
    try:
        probe.main()
    except SystemExit as e:
        code = e.code
    finally:
        sys.stdout = real
    return code, buf.getvalue()


passed = failed = 0
def check(label, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1; print('  ok   ' + label)
    else:
        failed += 1; print('  FAIL ' + label + ('\n         ' + detail if detail else ''))


print('the form is up')
code, out = run(json.dumps(OK_GET), json.dumps(OK_POST))
check('exits 0', code == 0, out)
check('says so', 'The report form is up.' in out)

print('\nthe form is down — each failure must name its remedy')

code, out = run(raises=urllib.error.HTTPError('u', 403, 'Forbidden', {}, None))
check('403 exits non-zero', code == 1)
check('403 blames the access setting', 'Who has access' in out, out)
check('403 blames the token expiry too', 'Testing' in out and '7 days' in out, out)

code, out = run(get='<html>Sign in to continue</html>', post=json.dumps(OK_POST))
check('a sign-in page is not mistaken for success', code == 1)
check('...and says the request never reached the script',
      'never reached the script' in out, out)

code, out = run(json.dumps(dict(OK_GET, chapters=['bwb_south_bay'])), json.dumps(OK_POST))
check('an organization missing from the server is caught', code == 1)
check('...and names it', 'kccb' in out, out)
check('...and says what it costs a volunteer', 'Unknown organization' in out, out)

code, out = run(json.dumps(dict(OK_GET, chapters=[])), json.dumps(OK_POST))
check('an empty allowlist is caught', code == 1)

code, out = run(json.dumps(dict(OK_GET, ok=False)), json.dumps(OK_POST))
check('ok:false is caught', code == 1)

# Something answering 200 with JSON is not proof our script ran.
code, out = run(json.dumps(OK_GET), json.dumps({'ok': True}))
check('a doPost that accepts the probe token is caught', code == 1)
check('...and doubts it is our script', 'may not be our script' in out, out)

code, out = run(raises=OSError('connection reset'))
check('an unreachable endpoint is caught', code == 1)
check('...and says so plainly', 'could not reach' in out, out)

code, out = run(raises=urllib.error.HTTPError('u', 500, 'Server Error', {}, None))
check('a 500 is caught', code == 1)

print('\n%d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)
