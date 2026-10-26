#!/usr/bin/env python3
"""Unit tests for tools/record_upload.py's call to the Apps Script.

WHY THIS EXISTS
    This is the one function every operator tool goes through — console.py's
    --check, --list, the whole upload-recording path — and until #61 it called
    urlopen with no handling at all. The 403 that killed the form for four days
    came out of here as forty lines of urllib internals ending in HTTPError,
    which names the symptom and nothing else. The cause was a setting in a
    dialog that no part of that traceback mentions.

    So these tests are about what the operator is told, not about the happy
    path. A failure that cannot be acted on is the same as no message.

USE
    python3 tools/test_record_upload.py
"""

import importlib.util
import io
import json
import os
import sys
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)        # record_upload imports probe_endpoint
spec = importlib.util.spec_from_file_location('ru', os.path.join(HERE, 'record_upload.py'))
ru = importlib.util.module_from_spec(spec)
sys.modules['ru'] = ru
spec.loader.exec_module(ru)

URL = 'https://script.google.com/macros/s/RECORD/exec'
SECRET = 'super-secret-admin-token'
PAYLOAD = {'action': 'mark-uploaded', 'adminToken': SECRET, 'submissionIds': []}


class Resp:
    def __init__(self, body):
        self._b = body.encode()
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False


def run(body=None, raises=None):
    """Call post() against a stubbed server; return (exit_code, stderr)."""
    seen = {}

    def fake_urlopen(req, timeout=None):
        seen['timeout'] = timeout
        if raises:
            raise raises
        return Resp(body)

    ru.urllib.request.urlopen = fake_urlopen

    buf, real = io.StringIO(), sys.stderr
    sys.stderr = buf
    code, result = 0, None
    try:
        result = ru.post(URL, PAYLOAD)
    except SystemExit as e:
        code = e.code
    finally:
        sys.stderr = real
    return code, buf.getvalue(), result, seen


passed = failed = 0
def check(label, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1; print('  ok   ' + label)
    else:
        failed += 1; print('  FAIL ' + label + ('\n         ' + detail if detail else ''))


print('the endpoint is working')
code, err, res, seen = run(body=json.dumps({'ok': True, 'updated': ['a']}))
check('a good reply comes back parsed', res == {'ok': True, 'updated': ['a']}, repr(res))
check('nothing is printed', err == '', err)
# A urlopen with no timeout can hang until someone notices, which on a Monday
# morning is indistinguishable from the script doing slow work.
check('the request has a timeout', seen['timeout'] == ru.TIMEOUT, repr(seen))

print('\nthe endpoint refuses — the operator must be told what to change')

code, err, res, seen = run(raises=urllib.error.HTTPError('u', 403, 'Forbidden', {}, None))
check('403 exits non-zero instead of raising', code == 1)
check('403 names the status', '403' in err, err)
# Shared with probe_endpoint.explain(). If these two ever drift, the copy being
# read in a car park is the one that is wrong.
check('403 blames the access setting', 'Who has access' in err, err)
check('403 blames the token expiry too', 'Testing' in err and '7 days' in err, err)

code, err, res, seen = run(raises=urllib.error.HTTPError('u', 500, 'Server Error', {}, None))
check('a 500 is caught', code == 1)
check('...and names the status', '500' in err, err)

print('\nsomething else answered — reachable is not working')

# A Google sign-in page is a 200 with HTML. Parsing that as a result is how a
# request that never reached the script gets recorded as having succeeded.
code, err, res, seen = run(body='<!DOCTYPE html><title>Sign in</title>')
check('a sign-in page is not returned as a result', code == 1 and res is None)
check('...and says the request never reached the script',
      'never reached the script' in err, err)
check('...and shows what did come back', 'DOCTYPE' in err, err)

print('\nthe endpoint cannot be reached at all')

code, err, res, seen = run(raises=urllib.error.URLError('connection reset'))
check('a network failure is caught', code == 1)
check('...and says so plainly', 'could not reach the endpoint' in err, err)
check('...and points at the tool that checks the endpoint on its own',
      'probe_endpoint.py' in err, err)

# OSError is not a URLError and would have escaped a narrower except clause.
code, err, res, seen = run(raises=OSError('host is down'))
check('a bare OSError is caught too', code == 1, err)

print('\nthe admin token must never reach the screen')

for label, kw in (('on a 403', {'raises': urllib.error.HTTPError('u', 403, 'F', {}, None)}),
                  ('on a sign-in page', {'body': '<html>' + SECRET + '</html>'}),
                  ('on a network failure', {'raises': urllib.error.URLError('down')})):
    code, err, res, seen = run(**kw)
    # The sign-in case is the one that could actually leak: the body is echoed
    # back, and an endpoint that reflected the request would put the token in
    # it. 120 characters of an HTML page is worth seeing; the token is not.
    check('no token in the output ' + label, SECRET not in err, err)

print('\n%d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)
