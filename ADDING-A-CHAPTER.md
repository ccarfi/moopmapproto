# Adding a BWB chapter to MOOP Map

Written from doing it for BWB United Kingdom. About 30 minutes, most of it
waiting for a redeploy.

Three systems have to agree: **Mapillary** (where the photos live),
**`config.js`** (what the map and form show), and **the Apps Script** (what the
report form is allowed to submit). Miss any one and the failure is quiet rather
than loud, so each step below ends with a check.

---

## 1. Create the Mapillary organization

Someone with a Mapillary account, on a **desktop web browser** — org management
doesn't work in the mobile app.

Click your username (top right) → click it again → **New organization**. Type a
name; no punctuation or emoji.

Two things that can't be undone later:

- **The URL slug** auto-fills from the name. Edit it now if you want it
  different — the display name can change afterwards, the slug can't.
- **The creator is permanently an admin.** You can add other admins, but you
  can't remove yourself. For a chapter you don't run, it's usually better for
  someone in that chapter to create it and add you, rather than the reverse.

Add their people under **Team**. New members default to *Contributor*, which can
upload and view but not manage.

The **organization key** is on the org dashboard. That's the number everything
else needs.

**Check it before using it** — a mistyped key fails in confusing ways:

```bash
curl -s "https://graph.mapillary.com/<ORG_KEY>?fields=id,slug,name&access_token=<token from config.js>"
```

You want the name you just typed. If it 400s, the key is wrong.

## 2. Add the chapter to `config.js`

A bounds constant, then an entry in `accounts`:

```js
const SCOTLAND_BOUNDS = { west: -8.7, south: 54.6, east: -0.7, north: 61.0 };

// …inside CONFIG.accounts:
{
  key: "bwb_scotland",              // also the bwb_chapter value in the Sheet
  label: "BWB Scotland",
  organizationId: "1234567890",
  color: "#7B9E3F",                 // must be visibly distinct from the others
  center: [56.8, -4.2],
  zoom: 7,
  bounds: SCOTLAND_BOUNDS
}
```

- **`key` must never change once reports exist.** It's written into every Sheet
  row and every Drive folder path for that chapter.
- **Keep `bounds` generous.** It drives the form's out-of-area warning and the
  pre-upload geofence check. A box that's too tight rejects legitimate reports;
  one that's too loose lets a stray through to human review. The second failure
  is much cheaper.
- `center` / `zoom` are where the map goes when someone taps the chapter name,
  and they're what a brand-new chapter with no photos falls back to.

Push to `main`. Pages redeploys in about a minute.

**Check:** the legend shows the new chapter at `0 images`, and clicking its name
flies the map there.

## 3. Allow the chapter in the Apps Script

The report form will offer the new chapter as soon as step 2 deploys, but the
server rejects anything not on its allowlist. Edit `CHAPTERS` in `Code.gs`:

```javascript
var CHAPTERS = ['bwb_south_bay', 'bwb_united_kingdom', 'bwb_scotland'];
```

Then **Deploy → Manage deployments → pencil → Version: New version → Deploy**.

> **Not "New deployment".** That mints a brand-new `/exec` URL and leaves the old
> one serving old code, so `CONFIG.upload.endpoint` has to be repointed. This
> caught us twice. Also note the Version dropdown defaults to the
> currently-deployed version — you have to actively pick *New version*, or you
> redeploy identical code and it looks like nothing happened.

**Check** — this reads the live `CHAPTERS` constant, so it's an answer rather
than an inference:

```bash
curl -sL "$(grep -o 'https://script.google.com[^"]*' config.js)"
```

```
{"service":"moop-report","chapters":["bwb_south_bay","bwb_united_kingdom"],"ok":true}
```

The new key must appear in that list. If it doesn't, the deploy didn't take.

**The `-L` matters.** Apps Script answers `/exec` with a 302 to
`script.googleusercontent.com`; without `-L` curl prints nothing at all, which
looks exactly like a broken deployment.

## 4. Test a real submission

On a phone, at <https://moopmap.org/report.html>:

1. Pick the new chapter
2. Send one photo
3. Confirm it lands in Drive under `inbox/<chapter>/<date>/`
4. Confirm the Sheet row shows the right `bwb_chapter` and
   `in_chapter_bounds: TRUE`

That last field is worth looking at. Every bounds test is otherwise negative —
"this is outside, warn" — and a box that rejects *everything* looks identical to
a working one until a real volunteer gets blocked.

## 5. First upload

Follow `RUNBOOK.md`, using **that chapter's** organization key.

> `--organization_key` is not optional, and it is per chapter. A photo uploaded
> without it lands on Mapillary and is invisible on this map. Take the key from
> the chapter's `config.js` entry; never hardcode it, or the next chapter to
> onboard silently uploads into South Bay.

---

## Before you announce it

**The form accepts reports the moment step 3 deploys.** Photos go into *your*
Drive and need *someone* to run the upload for them to appear. If the new
chapter has nobody doing that yet, either hold off on step 3 or be clear with
them about the lag.

**A new chapter shows `0 images` and one lonely dot after the first upload.**
That's normal, but it looks broken to someone who doesn't know. Worth saying so
when you send them `HOW-TO-REPORT.md`.

## What tends to go wrong

| Symptom | Cause |
| --- | --- |
| `Unknown chapter` on submit | Step 3 not deployed, or deployed as the same version |
| Form works, but the endpoint URL changed | Used "New deployment" instead of "New version" |
| Chapter shows `0 images` with photos on Mapillary | Uploaded without `--organization_key`, or the wrong one |
| Photos fetched then vanish | Their positions fall outside the chapter's `bounds` |
| Map opens on the ocean | Two chapters far apart — expected; the map focuses one at a time |
