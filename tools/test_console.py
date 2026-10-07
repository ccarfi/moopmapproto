#!/usr/bin/env python3
"""Unit tests for the parts of console.py that decide what to warn about.

WHY THIS EXISTS
    digest_warnings() turns a health payload into sentences, and it is the
    only thing standing between a dead digest and nobody noticing. Its
    failure mode is silence, which is also what success looks like, so it
    cannot be checked by running it once and seeing nothing happen.

USE
    python3 tools/test_console.py
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('console_under_test',
                                              os.path.join(HERE, 'console.py'))
console = importlib.util.module_from_spec(spec)
sys.modules['console_under_test'] = console
spec.loader.exec_module(console)

HEALTHY = {
    'triggers': ['dailyDigest', 'scheduledConfirm'],
    'digestLastCompletedAt': '2026-10-07T15:26:00.000Z',
    'digestStaleDays': 0,
    'codeVersion': '2026-10-07.2',
    'headVersion': '2026-10-07.2',
}


def case(label, overrides, want):
    res = dict(HEALTHY, **overrides)
    got = console.digest_warnings(res)
    ok = len(got) == want
    print(('  ok   ' if ok else '  FAIL ') + '%-42s %d warning(s)' % (label, len(got)))
    if not ok:
        print('         expected %d' % want)
        for w in got:
            print('         - ' + w.split('\n')[0])
    return ok


CASES = [
    ('healthy, ran today',                      {}, 0),
    ('healthy, ran yesterday',                   {'digestStaleDays': 1}, 0),
    ('two days stale',                           {'digestStaleDays': 2}, 1),
    ('a week stale',                             {'digestStaleDays': 7}, 1),
    ('never stamped',                            {'digestLastCompletedAt': None,
                                                  'digestStaleDays': None}, 1),
    ('dailyDigest trigger deleted',              {'triggers': ['scheduledConfirm']}, 1),
    ('scheduledConfirm trigger deleted',         {'triggers': ['dailyDigest']}, 1),
    ('both triggers gone, never stamped',        {'triggers': [],
                                                  'digestLastCompletedAt': None,
                                                  'digestStaleDays': None}, 3),
    ('trigger list unreadable',                  {'triggers': None}, 1),

    # The drift check: triggers run the saved project, doPost runs the
    # deployment, so these differing means a redeploy did not take.
    ('deploy drift — editor ahead of /exec',     {'headVersion': '2026-10-07.3'}, 1),
    ('deploy drift plus a stale digest',         {'headVersion': '2026-10-07.3',
                                                  'digestStaleDays': 4}, 2),
    ('no drift when they agree',                 {}, 0),
    ('head version not recorded yet, no drift',  {'headVersion': None}, 0),
    ('deployed version missing, no drift',       {'codeVersion': None}, 0),
]

print('digest_warnings')
bad = sum(not case(*c) for c in CASES)

print('\n--- what the operator sees when a redeploy silently did not take ---')
for w in console.digest_warnings(dict(HEALTHY, headVersion='2026-10-07.3')):
    print('\nWARNING: ' + w.replace('\n', '\n         '))

print('\n%d passed, %d failed' % (len(CASES) - bad, bad))
sys.exit(1 if bad else 0)
