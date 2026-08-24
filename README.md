# Fuel Line — self-hosted server

A shared, live ultramarathon fueling tracker. One race, many viewers: anyone with
the link sees the same timer, the same log, and can add intake entries, notes, or
laps from their own device. The server is the source of truth, so the race keeps
"running" (the clock is always correct) even if every browser tab is closed —
and auto-laps still get recorded in the background even if nobody has the page open.

Deliberately simple: one server process, one dependency (Express), plain HTTP.
No WebSockets, no database to install — each race is just a small JSON file.
Every open tab quietly re-checks the server every few seconds, so a change one
person makes shows up for everyone else within a handful of seconds — good
enough for a crew coordinating in person or by radio, without the extra moving
parts a real-time push connection would add.

## What's here

```
server.js             Express server — plain REST endpoints, no WebSockets
raceLogic.js           Pure race-state logic — no dependencies, fully unit-testable
raceLogic.test.js       Unit tests for raceLogic.js (30 checks, incl. auto-lap catch-up)
public/landing.html    "Start a new race" / "Join a race by code"
public/race.html        The tracker itself (setup / race / summary views)
public/not-found.html   Shown for an unknown race code
data/                    One JSON file per race, created automatically — this is your database
```

## Running it locally

```bash
npm install
npm test        # runs raceLogic.test.js — confirm this passes before trusting it on race day
npm start        # starts the server on http://localhost:3000
```

Open `http://localhost:3000`, click **Start new race**, fill out the setup page, then
click **Share** in the top bar to get a link. Anyone on the same network who opens
that link (e.g. `http://<your-laptop-ip>:3000/r/ab12cd34`) sees and can update the
same race — refreshing the page, or opening the link fresh on a different phone,
always shows the race exactly where it actually is.

## How it works, in short

- **The timer never "runs" anywhere.** It's computed on demand from an absolute
  start timestamp the server recorded (`now − startTimestamp − paused time`).
  So refreshing the page, closing the tab, or opening the link on a totally
  different device always gives the correct elapsed time — there's no counter
  that needs to keep ticking somewhere for this to work.
- **Every action is a small HTTP request.** Clicking Start, Pause, Lap, Log
  Intake, or Add Note sends one `POST /api/races/:id/actions` request; the
  server applies it, saves it to that race's JSON file, and hands back the
  full current state, which is what you see update immediately.
- **Every open tab polls `GET /api/races/:id` every 4 seconds** to pick up
  whatever anyone else did. There's no persistent connection to manage or
  reconnect — if a poll fails (phone loses signal for a second), the next one
  a few seconds later just quietly catches up.
- **Auto-lap runs on the server itself**, checking every 5 seconds whether a
  lap is due, independent of whether anyone has the page open — that's what
  makes it accurate even if nobody looks at their phone for an hour.

## Deploying so your crew can reach it from their phones

You need the server process reachable from whatever network your crew is on
for the duration of the race, plus a folder that survives restarts for `data/`.

**Fly.io / Render / Railway (easiest)**
1. Push this folder to a Git repo, or use the CLI to deploy it directly.
2. Point the service at `npm start`; these platforms set `PORT` automatically
   and the server already reads it.
3. **Attach a persistent volume/disk** and set the `DATA_DIR` environment
   variable to its mount path. Without a persistent disk, a redeploy or
   restart on some of these platforms wipes the filesystem and you'd lose the
   race data — the app itself still works fine either way, just be aware of
   this before race day.
4. HTTPS comes for free on all three, which is all this app needs (no special
   WebSocket/proxy configuration required, since there isn't one).

**A VPS you already have (most control)**
```bash
git clone <your repo> fuel-line && cd fuel-line
npm install
npm test
npm install -g pm2
pm2 start server.js --name fuel-line
pm2 save
```
Put nginx or Caddy in front for HTTPS and a normal domain name. `data/` lives
on the VPS's normal disk, so it survives reboots as long as you don't delete
the folder.

**Just for the weekend, no real hosting**
Run `npm start` on a laptop that'll stay on and connected, then use a tunnel
tool (e.g. `ngrok http 3000` or Cloudflare Tunnel) to get a temporary public
URL to share with crew. Simplest option if you don't want to manage a real
deployment, at the cost of depending on that one laptop's power/network for
the whole race.

## Operational notes worth knowing before race day

- **One race per link.** If you want to run this for a future race, click "Start
  new race" again for a fresh code — old race data isn't deleted, it just sits in
  `data/` under its old code in case you want it later.
- **No login, no permissions.** Anyone with the link can log intake, change
  targets, or hit Reset. That's the intended trade-off for something this
  lightweight, but don't post the link somewhere public.
- **Updates land within ~4 seconds, not instantly.** If two crew members are
  standing at the same aid station both looking at their phones, one might see
  the other's entry appear a few seconds late rather than immediately — fine
  for coordinating a support crew, not built for split-second syncing.
- **Simple conflict handling.** Each action (a log entry, a lap, a target
  change) is applied as its own small, independent update, so two people
  acting near-simultaneously don't wipe out each other's entries — the rare
  case where it matters is if two people edit the *same* setting (like
  targets) at almost the same moment, in which case whichever the server
  processed a few milliseconds later wins.
- **Clock skew is handled.** Every device syncs its idea of "now" to the
  server's clock on each poll, so it doesn't matter if someone's phone clock
  is off.
