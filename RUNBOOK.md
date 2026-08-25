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

Every photo's position — EXIF first, the Sheet's `device_lat`/`device_lng` as
fallback — should sit inside that chapter's `bounds` in `config.js`.

**If anything falls outside, stop and look at it.** A Mapillary upload is
public, permanent and awkward to retract; this is the last cheap moment to
catch "these were all shot in Toledo". The form only warns, and the warning can
be overridden, so this check is the real gate.

Move offenders to `failed/<chapter>/` rather than deleting them. The usual
cause is a mis-picked chapter, not a bad photo, and they just need re-filing.

**3. Upload, with the organization key.**

```bash
mapillary_tools process_and_upload ./bwb_south_bay/2026-08-23 \
  --user_name "<your mapillary username>" \
  --organization_key "1605841191131530"
```

> **`--organization_key` is not optional.** The map filters by
> `organization_id`. A photo uploaded without it lands on Mapillary and is
> invisible on this map — confirmed: `creator_username` and `organization_id`
> return disjoint result sets. Take the key from the chapter's entry in
> `config.js`; never hardcode it here, or the second chapter to onboard will
> silently upload into South Bay.

**4. For photos whose EXIF GPS was stripped.**

iOS share sheets strip EXIF fairly often, which is why the form records a
device position alongside each submission. Build an image description file from
the Sheet's coordinates:

```json
[
  {
    "filename": "/abs/path/bwb_south_bay/2026-08-23/2026-08-23T17-42-11Z__abc__1.jpg",
    "MAPLatitude": 37.129448,
    "MAPLongitude": -121.659560,
    "MAPCaptureTime": "2026_08_23_09_42_11_000"
  }
]
```

```bash
mapillary_tools upload ./bwb_south_bay/2026-08-23 \
  --desc_path ./desc.json \
  --user_name "<your mapillary username>" \
  --organization_key "1605841191131530"
```

> **Unverified:** `MAPCaptureTime` is `YYYY_MM_DD_HH_MM_SS_mmm` with no
> timezone, and it isn't documented whether that's read as local or UTC.
> Everything else in this project is pinned to `America/Los_Angeles`. Getting
> this wrong shifts capture dates by up to a day, which would quietly corrupt
> the date filter. **Test with one photo and check the date that comes back
> through the API before relying on this path.**

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
