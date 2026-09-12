# Runbook — Drive to Mapillary

Photos submitted through `report.html` land in Drive. This is how they get to
Mapillary, where the map reads them from.

Manual for now. The folder layout is designed so this can become a scheduled
job later without rethinking anything.

## Before the first run

```bash
pipx install mapillary_tools     # or: pip install mapillary_tools
mapillary_tools authenticate     # a Mapillary account with upload rights
```

You also need each chapter's organization key. It's in `config.js` as
`accounts[].organizationId` — read it from there rather than typing it from
memory.

## Each run

**1. Pull down one chapter/date folder from Drive.**

```
MoopMap Uploads/inbox/bwb_south_bay/2026-08-23/
```

One chapter at a time. Each chapter uploads under its own organization key, so
a mixed folder cannot be uploaded in a single command.

**2. Check the geofence before uploading, not after.**

Every photo's position — in practice the Sheet's `device_lat`/`device_lng`, see
step 4 — should sit inside that chapter's `bounds` in `config.js`.

**If anything falls outside, stop and look at it.** A Mapillary upload is
public, permanent and awkward to retract; this is the last cheap moment to
catch "these were all shot in Toledo". The form only warns, and the warning can
be overridden, so this check is the real gate.

Move offenders to `failed/<chapter>/` rather than deleting them. The usual
cause is a mis-picked chapter, not a bad photo, and they just need re-filing.

**3. Note the organization key you'll upload under.**

> **`--organization_key` is not optional.** The map filters by
> `organization_id`. A photo uploaded without it lands on Mapillary and is
> invisible on this map — confirmed: `creator_username` and `organization_id`
> return disjoint result sets. Take the key from the chapter's entry in
> `config.js`; never hardcode it here, or the second chapter to onboard will
> silently upload into South Bay.

`process_and_upload` is not usable here: it reads position and time from EXIF,
which these photos do not have. Use `upload` with a description file instead.

**4. Build the description file — you will need it every time.**

> **iOS strips EXIF from every photo picked through a web file input.** Not
> occasionally — always, in both Safari and Brave, confirmed on real
> submissions. What survives is a 140-byte stub holding orientation, resolution
> and pixel dimensions. No GPS, no capture time, no camera model. The pixels are
> untouched at full resolution.
>
> So the device position the form records is **not a fallback, it is the only
> source**. Every batch from the form needs a description file. A submission
> with no device position (Brave silently denies geolocation) cannot be placed
> by any means and has to go to `failed/`.

Build it from the Sheet's `device_lat` / `device_lng`:

```json
[
  {
    "filename": "/abs/path/bwb_south_bay/2026-08-23/2026-08-23T17-42-11Z__abc__1.jpg",
    "MAPLatitude": 37.129448,
    "MAPLongitude": -121.659560,
    "MAPCaptureTime": "2026_08_23_17_42_11_000",
    "filetype": "image"
  }
]
```

Two things the published examples leave out:

- **`filetype: "image"` is required.** Without it the upload dies with
  `KeyError: 'filetype'` in the deserializer. The docs example omits it.
- **`MAPCaptureTime` is UTC.** Settled from the installed source, not guessed —
  `parse_capture_time()` does `strptime(...).replace(tzinfo=timezone.utc)`, and
  `build_capture_time()` converts to UTC with the comment *"otherwise it will be
  assumed to be in local time"*. The filename stamp the Apps Script writes is
  already UTC, so use it directly.

Only `MAPLatitude`, `MAPLongitude` and `MAPCaptureTime` are required by the
schema, plus `filetype` by the loader.

```bash
mapillary_tools upload ./bwb_south_bay/2026-08-23 \
  --desc_path ./desc.json \
  --user_name "<your mapillary username>" \
  --organization_key "1605841191131530"
```

### The mapillary_tools progress bug (0.14.7)

`mapillary_tools upload` **crashes partway through and publishes nothing**:

```
TypeError: '<' not supported between instances of 'NoneType' and 'int'
  upload_pbar.update(payload["chunk_size"])
```

The upload event payload carries `chunk_size=None`, tqdm rejects it, and the
exception aborts the run before the sequence is finished. There is no flag to
turn the progress bar off. Run it through this wrapper instead:

```python
# mly_upload.py
import sys, tqdm.std
_orig = tqdm.std.tqdm.update
def _safe(self, n=1):
    return _orig(self, 0 if n is None else n)
tqdm.std.tqdm.update = _safe
from mapillary_tools.commands.__main__ import main
sys.argv = ["mapillary_tools"] + sys.argv[1:]
sys.exit(main())
```

```bash
python3 mly_upload.py upload ./bwb_south_bay/2026-08-23 \
  --desc_path desc.json --user_name "<you>" --organization_key "<org id>"
```

**Ignore the byte counters.** The same malformed payload means the summary
reports `0 Bytes read` and `0 Bytes uploaded` even on a successful upload. They
are not evidence of anything.

**Confirm success by the cluster ID instead.** A finished sequence is recorded
in `~/Library/Application Support/mapillary_tools/upload_history/**/*.json`:

```json
{ "sequence_image_count": 4, "cluster_id": "1373360548178058" }
```

A `cluster_id` means Mapillary accepted and registered the sequence. No
`cluster_id` means it did not, whatever the summary said.

**5. Close the loop.**

- Move the folder from `inbox/` to `uploaded/`. This is what makes a re-run
  idempotent — `inbox/` is the work queue, so anything still in it is unsent.
- Set `status` to `uploaded` and stamp `mapillary_uploaded_at` on those rows in
  the Sheet.

**6. Confirm.**

Mapillary processing takes a while — expect hours, sometimes longer. Once
done, the photos appear on the map with no code change, because they arrive
through the same `organization_id` query that already drives it. Add
`?refresh=1` to the map URL to bypass the session cache.

## When this becomes automated

The pieces that make that a scripting job rather than a redesign:

- `inbox/` is a queue and `uploaded/` is the archive, so "what's outstanding"
  is a directory listing.
- Chapter sits above date in the tree, so a batch is already scoped to one
  organization key.
- The Sheet carries `status` per submission, so progress survives a crash
  mid-run.

The credentials are the part that needs thought. A Mapillary user token and
Drive access would have to live as GitHub Actions secrets — **never in
`config.js`**, which is public. The read-only Mapillary token there is safe
precisely because it is read-only; that reasoning does not carry over to a
token that can upload.

## If nobody runs this

Submissions pile up in `inbox/` unnoticed and volunteers see nothing appear.
Worth a periodic look at the Sheet for rows still marked `pending`.
