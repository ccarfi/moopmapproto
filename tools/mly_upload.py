#!/usr/bin/env python3
"""Wrapper around mapillary_tools that survives its broken progress bar.

WHY THIS EXISTS
    mapillary_tools 0.14.7 crashes partway through an upload and publishes
    nothing:

        TypeError: '<' not supported between instances of 'NoneType' and 'int'
          upload_pbar.update(payload["chunk_size"])

    The upload event payload carries chunk_size=None, tqdm's `if n < 0` raises,
    and the exception aborts the run *before the sequence is finished* — so
    Mapillary never registers it. The summary then prints "Nothing uploaded".
    There is no flag to turn the progress bar off.

    Coercing None to 0 fixes only the display. The transfer itself is untouched.

USE
    python3 tools/mly_upload.py upload ./bwb_south_bay/2026-08-23 \\
      --desc_path desc.json \\
      --user_name "<your mapillary username>" \\
      --organization_key "<the chapter's organizationId from config.js>"

    Arguments are passed straight through, so anything mapillary_tools accepts
    works here. Add --dry_run to write to a local directory instead of
    Mapillary.

READING THE RESULT
    Ignore the byte counters. The same malformed payload means a *successful*
    upload still reports "0 Bytes read" and "0 Bytes uploaded". They are not
    evidence of anything.

    Confirm success by the cluster ID instead, in
    ~/Library/Application Support/mapillary_tools/upload_history/**/*.json:

        { "sequence_image_count": 4, "cluster_id": "1373360548178058" }

    A cluster_id means Mapillary accepted and registered the sequence. No
    cluster_id means it did not, whatever the summary said.

    See RUNBOOK.md for the surrounding process.

WHEN TO DELETE THIS
    Check whether the upstream bug is fixed after upgrading mapillary_tools:

        pip3 install -U mapillary_tools

    Then try a --dry_run without this wrapper. If it completes and reports a
    non-zero byte count, this file has done its job and can go.
"""

import sys

import tqdm.std

_orig_update = tqdm.std.tqdm.update


def _safe_update(self, n=1):
    """tqdm.update() rejects None; the upload payload supplies it."""
    return _orig_update(self, 0 if n is None else n)


tqdm.std.tqdm.update = _safe_update

from mapillary_tools.commands.__main__ import main  # noqa: E402  (after the patch)

if __name__ == "__main__":
    sys.argv = ["mapillary_tools"] + sys.argv[1:]
    sys.exit(main())
