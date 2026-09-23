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

**2. The geofence check is automatic.**

`tools/build_desc.py` in step 4 refuses to build a description file if any
photo's position falls outside that chapter's `bounds` in `config.js`, and names
the offenders. A Mapillary upload is public, permanent and awkward to retract,
so this is the last cheap moment to catch "these were all shot in Toledo" — and
the form's own warning is deliberately soft and overridable, which makes this
the real gate.

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

**Don't build it by hand.** `tools/build_desc.py` does the matching, keying on
the submission id embedded in each filename so a photo can only ever be paired
with its own row:

```bash
# Sheet -> File -> Download -> Comma-separated values
python3 tools/build_desc.py ./bwb_south_bay/2026-08-23 --sheet ~/Downloads/submissions.csv
```

It writes `desc.json` beside the photos and prints the upload command with that
chapter's organization key already filled in — which is also how the key stops
being something you retype.

**It refuses to build** if any photo's position falls outside the chapter's
`bounds`, if a photo has no matching Sheet row, or if the folder's chapter
disagrees with the Sheet's. Those are the cases that put imagery somewhere wrong
and public. Photos with no position at all are skipped with a reason rather than
failing the run — they belong in `failed/<chapter>/`. `--force` overrides the
bounds check, deliberately.

This replaces step 2's manual geofence check: the script is the gate now, rather
than a paragraph asking a human to look.

For reference, the format it produces:

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
python3 tools/mly_upload.py upload ./bwb_south_bay/2026-08-23 \
  --desc_path ./desc.json \
  --user_name "<your mapillary username>" \
  --organization_key "1605841191131530"
```

(Use the wrapper, not `mapillary_tools` directly — see below.)

### The mapillary_tools progress bug (0.14.7)

`mapillary_tools upload` **crashes partway through and publishes nothing**:

```
TypeError: '<' not supported between instances of 'NoneType' and 'int'
  upload_pbar.update(payload["chunk_size"])
```

The upload event payload carries `chunk_size=None`, tqdm rejects it, and the
exception aborts the run before the sequence is finished. There is no flag to
turn the progress bar off, so use **`tools/mly_upload.py`** in this repo — it
patches the progress bar and passes everything else straight through:

```bash
python3 tools/mly_upload.py upload ./bwb_south_bay/2026-08-23 \
  --desc_path desc.json --user_name "<you>" --organization_key "<org id>"
```

That file also documents how to tell whether the upstream bug has been fixed,
so the workaround can be deleted rather than carried forever.

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
- In the Sheet, on those rows: set `status` to `uploaded`, stamp
  `mapillary_uploaded_at`, and paste the `cluster_id` into
  `mapillary_cluster_id`.

The cluster id matters more than it looks. It is the only durable handle joining
a Sheet row to what actually exists on Mapillary, and it otherwise lives solely
in a local file under `~/Library`, on whichever machine happened to run the
upload. If you ever need to find, dispute or explain a sequence, that number is
the thread.

For anything that did **not** go up — no position, wrong chapter, a deliberate
test — set `status` to `failed` and write why in `notes`. `failed` on its own
reads as a system fault when someone looks back in six months; "no location —
Brave denied geolocation" reads as what it was.

**6. Confirm.**

Mapillary processing takes a while — expect hours, sometimes longer. Once
done, the photos appear on the map with no code change, because they arrive
through the same `organization_id` query that already drives it.

Check at **<https://moopmap.org/?refresh=1>** — the `?refresh=1` bypasses the
session cache, which otherwise serves the counts from before the upload.

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
