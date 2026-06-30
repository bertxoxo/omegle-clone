# Strangr (MVP) — Random Stranger Chat Scaffold

## What this is
A working scaffold for a random-pairing video/text chat site, with:
- Video chat OR text-only mode (user picks one)
- Optional country + free-text interest tag filters
- Matching rule: filtered users only match other filtered users with overlapping
  filters; "universal" users (no filters set) match with anyone
- A Report button that logs reports (with priority flag for "minor concern")
  to `reports.json`
- Self-attestation 18+ checkbox gate (NOT real age verification)

## What this is NOT (yet)
This is a dev scaffold, not something to put in front of the public. Before
any real launch you still need:
- Real ID-based age verification (e.g. Persona, Veriff, Stripe Identity)
- CSAM hash-matching / content moderation on video streams (e.g. Thorn Safer,
  PhotoDNA) — this is a legal requirement in many jurisdictions, not optional
- A moderator dashboard to actually review `reports.json` entries
- Terms of Service + Privacy Policy reviewed by a lawyer
- Rate limiting / abuse prevention (captchas, IP throttling, ban lists)
- Persistent storage (currently reports are a flat JSON file — fine for
  testing, not for production)

## Running it locally
Requires Node.js (v18+ recommended).

```bash
cd omegle-clone
npm install
npm start
```

Then open http://localhost:3000 in two different browser tabs/windows (or
two devices) to simulate two strangers matching with each other.

## File structure
- `server.js` — Express + Socket.io server: matchmaking queue, WebRTC
  signaling relay, chat relay, report logging
- `public/index.html` — UI: setup/age-gate screen + chat screen + report modal
- `public/app.js` — client logic: WebRTC peer connection, socket events,
  chat send/receive, report submission
- `reports.json` — auto-created; stores submitted reports (hashed user IDs,
  reason, timestamp, priority)

## Notes on the matching logic
See the comment block at the top of `server.js` for the exact rule. Briefly:
- Same mode (video/video or text/text) is always required to match.
- If either user is "universal" (no country, no tags set), they can match
  with anyone in that mode.
- If both users have filters set, country must match (if both specified) and
  tags must overlap by at least one (if both specified).
