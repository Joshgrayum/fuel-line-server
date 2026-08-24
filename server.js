"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const rl = require("./raceLogic.js");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// raceId -> state object (in-memory source of truth; persisted to disk on every mutation)
const races = new Map();

function raceFile(id) {
  return path.join(DATA_DIR, id + ".json");
}

function loadAllRaces() {
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  } catch (e) {
    console.error("Could not read data dir:", e.message);
    return;
  }
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, f), "utf8");
      races.set(id, JSON.parse(raw));
    } catch (e) {
      console.error("Failed to load race file", f, e.message);
    }
  }
  console.log("Loaded " + races.size + " race(s) from disk.");
}

// Atomic-ish write: write to a temp file then rename over the real one, so a
// crash mid-write can never leave a half-written / corrupt race file behind.
function persistRace(id) {
  const state = races.get(id);
  if (!state) return;
  const target = raceFile(id);
  const tmp = target + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch (e) {
    console.error("Failed to persist race", id, e.message);
  }
}

function newRaceId() {
  return crypto.randomBytes(4).toString("hex"); // 8 hex chars, easy to read/share
}

function createRace() {
  let id = newRaceId();
  while (races.has(id)) id = newRaceId();
  races.set(id, rl.defaultState());
  persistRace(id);
  return id;
}

// ---------------- HTTP app ----------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

app.post("/api/races", (req, res) => {
  const id = createRace();
  res.json({ id });
});

app.get("/api/races/:id/exists", (req, res) => {
  res.json({ exists: races.has(req.params.id) });
});

// Polled by every open tab every few seconds to pick up whatever anyone else
// (or the auto-lap background check) has changed.
app.get("/api/races/:id", (req, res) => {
  const state = races.get(req.params.id);
  if (!state) return res.status(404).json({ error: "Race not found." });
  res.json({ state, serverNow: Date.now() });
});

// Every button in the UI (start, pause, lap, log intake, add note, ...) posts
// one small action here. Applied immediately, persisted, and the resulting
// state is returned so the person who acted sees it right away without
// waiting for their next poll.
app.post("/api/races/:id/actions", (req, res) => {
  const state = races.get(req.params.id);
  if (!state) return res.status(404).json({ error: "Race not found." });
  const action = req.body;
  if (!action || typeof action.type !== "string") {
    return res.status(400).json({ error: "Malformed action." });
  }
  try {
    rl.applyAction(state, action);
  } catch (e) {
    console.error("applyAction error for race", req.params.id, e);
    return res.status(500).json({ error: "Could not apply action." });
  }
  persistRace(req.params.id);
  res.json({ state, serverNow: Date.now() });
});

app.get("/r/:id", (req, res) => {
  if (!races.has(req.params.id)) {
    res.status(404).sendFile(path.join(__dirname, "public", "not-found.html"));
    return;
  }
  res.sendFile(path.join(__dirname, "public", "race.html"));
});

app.get("/healthz", (req, res) => res.json({ ok: true, races: races.size }));

// Background maintenance: insert any due auto-laps even if nobody currently
// has the page open, so the log is accurate whenever someone next polls.
setInterval(() => {
  for (const [raceId, state] of races.entries()) {
    let changed = false;
    try {
      changed = rl.checkAutoLap(state);
    } catch (e) {
      console.error("checkAutoLap error for race", raceId, e);
      continue;
    }
    if (changed) persistRace(raceId);
  }
}, 5000);

loadAllRaces();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Fuel Line server listening on port " + PORT);
});
