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

To see what is waiting without opening Drive:

```bash
python3 tools/console.py --list
```

```
waiting in inbox/:
  bwb_south_bay        2026-09-25   7 photos
```


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

### Or review it in the console

```bash
export MOOPMAP_ADMIN_TOKEN='...'
export MAPILLARY_USER='<your mapillary username>'
python3 tools/console.py ./bwb_south_bay/2026-09-24 --sheet ~/Downloads/submissions.csv
```

Opens a local page showing every photo in the batch with its position, a map,
and a tick box. Press Upload and it builds the description file, uploads only
what you ticked, records the result in the Sheet, files anything unuploadable
into `failed/<chapter>/`, and moves the batch to `uploaded/` — steps 4 and 5
below in one pass.

**If the Sheet write does not fully land, nothing moves in Drive.** A conflict
or an unknown submission id means the Sheet is not what you think it is, and
emptying the queue on top of that compounds it. The batch stays in `inbox/`
and the console says why.

**Why it exists:** the CLI is all-or-nothing. `build_desc.py` refuses the whole
batch if any photo is out of bounds, and `--force` suppresses the check for
everything in it — forcing twenty photos to publish nineteen good ones is how
a bad one goes public. The console makes that a per-photo decision.

Defaults do the work: in-bounds JPEGs with a position arrive ticked, everything
else arrives unticked with the reason shown. Out-of-bounds photos are offered
rather than blocked. The only confirmation is the upload itself, because that
is the only step that is public and permanent.

It serves on 127.0.0.1 and refuses to bind anywhere else — it holds the admin
token and can publish. The token never reaches the page.

The CLI path below still works, and is what to reach for when something is
wrong with the console.

---

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
and public. `--force` overrides the bounds check, deliberately.

**Files it can't use are named, not skipped silently** — no position recorded,
or not a JPEG. Neither can be uploaded by any means, so they belong in
`failed/<chapter>/`. The report is the only thing standing between those and a
photo that sits in `inbox/` indefinitely with nobody told why.

> **Mapillary takes `.jpg`/`.jpeg` and nothing else** — `IMAGE_EXTENSIONS` in
> `mapillary_tools/utils.py`. A **`.png` is almost always an iPhone
> screenshot**: someone screenshotted their camera roll instead of sharing the
> photo. There's no fix at this end — converting a screenshot to JPEG gives you
> a JPEG of a screenshot, with the phone's UI in it and no better provenance.
> Ask for the original. `report.html` now rejects non-JPEG at the picker, so
> this should only turn up in batches submitted before that shipped.

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

```bash
export MOOPMAP_ADMIN_TOKEN='...'      # once per shell; never in this repo
python3 tools/record_upload.py ./bwb_south_bay/2026-09-24
```

That reads the `cluster_id` out of `upload_history`, matches it to the batch,
and sets `status`, `mapillary_uploaded_at` and `mapillary_cluster_id` on every
row. `--dry-run` shows what it would send.

It finds the cluster by **matching the batch's set of filenames** against each
history entry, not by taking the newest one — two batches uploaded minutes
apart would make "newest" wrong, and wrong here records a photo against another
chapter's sequence. If the filenames appear under two clusters it refuses
rather than guessing.

For anything that did **not** go up — no position, not a JPEG, a deliberate
test — say why:

```bash
python3 tools/record_upload.py . --failed <filename> --reason "no location — Brave denied geolocation"
```

`--reason` is required. `failed` on its own reads as a system fault when
someone looks back in six months; "no location — Brave denied geolocation"
reads as what it was.

**Then** move the folder from `inbox/` to `uploaded/`. That order matters: a
crash between the two should leave a folder to re-examine, not a cluster id
that was never recorded. Re-running an upload is cheap; reconstructing a lost
cluster id is not. `inbox/` is the work queue, so anything still in it is
unsent.

The cluster id matters more than it looks. It is the only durable handle joining
a Sheet row to what actually exists on Mapillary, and it otherwise lives solely
in a local file under `~/Library`, on whichever machine happened to run the
upload. If you ever need to find, dispute or explain a sequence, that number is
the thread.

> **`MOOPMAP_ADMIN_TOKEN` is not `SHARED_TOKEN`.** `SHARED_TOKEN` ships in
> `config.js` in a public repo, which is fine while the worst anyone can do is
> push junk photos into `inbox/` for a human to look at. A write path is
> different: with a public token anyone could mark rows uploaded, invent
> cluster ids, or overwrite `notes`. The admin token lives only in the deployed
> Apps Script and in your environment. `curl -sL <your /exec>` reports
> `adminConfigured` so you can check it's set without revealing it.

**6. Confirmation is automatic.**

`confirmUploads()` in the Apps Script sweeps every 6 hours, and flips rows from
`uploaded` to `live` once the imagery is actually visible. Anything still
unconfirmed after `CONFIRM_OVERDUE_DAYS` (3) shows up in the daily digest.

So `uploaded` means "Mapillary accepted the sequence" and `live` means "it is
on the map". They are not the same, and the gap is hours.

> **It matches on capture time, not cluster id.** `mapillary_tools` records a
> numeric `cluster_id` (`1771855540796619`); the Graph API reports a sequence
> id (`34UFCwEdWaLpRDVJcoqTg9`). They are different identifiers and do not
> join — checked against live data. `captured_at` does, because it comes from
> `MAPCaptureTime`, which `build_desc.py` takes from the filename stamp. That
> makes confirmation per photo rather than per batch, and it works for rows
> that predate the `mapillary_cluster_id` column.

A failed Mapillary fetch leaves rows alone rather than reporting them missing:
an outage must not look like imagery that never appeared.

To look yourself: **<https://moopmap.org/?refresh=1>** — the `?refresh=1`
bypasses the session cache, which otherwise serves the counts from before the
upload.

## When this becomes automated

The pieces that make that a scripting job rather than a redesign:

- `inbox/` is a queue and `uploaded/` is the archive, so "what's outstanding"
  is a directory listing.
- Status is a lifecycle, not a flag: `pending` -> `uploaded` -> `live`, with
  `failed` off to the side. Each step is independently checkable.
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

Submissions pile up in `inbox/` and volunteers see nothing appear — and with
chapters submitting into a Drive that isn't theirs, they have no way to tell
the difference between "waiting" and "broken".

`dailyDigest()` in `apps-script/Code.gs` guards against that. A time-driven
trigger counts `pending` rows once a day and emails a per-chapter breakdown
with the age of the oldest. **It sends nothing when there is nothing pending**,
deliberately: silence has to mean "queue clear", or the mail becomes noise and
gets filtered, which is the failure it exists to prevent.

It counts rows that can never be uploaded — no position, or not a JPEG —
separately, so the headline number is work an upload run can actually clear.
Those need a `failed` mark and a note instead.

Install it by running `installDigestTrigger()` once from the Apps Script
editor. It's idempotent, so running it again won't leave you with two digests
a day.

> Sheets' own notification rules cannot do this job, which is worth knowing
> before someone tries. They don't fire for your own edits, and the web app is
> deployed **Execute as: Me** — so every row the script writes is the owner's
> edit. Such a rule looks configured and does nothing.
