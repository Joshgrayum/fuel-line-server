"use strict";
// Pure race-state logic. No dependencies, so it can be unit-tested directly with `node`.
// The server is the single source of truth: every mutation goes through applyAction(),
// and the resulting state is broadcast to every connected client.

function defaultState() {
  return {
    setup: { raceName: "", scheduledStart: "", terrain: "trail", startTemp: "", tempUnit: "F", conditions: "sunny", notes: "" },
    autoLap: { enabled: false, intervalMinutes: 30 },
    targets: [{ atElapsedMs: 0, cal: 250, carb: 60, fluid: 500, electrolyte: 500 }],
    timer: { status: "setup", startTimestamp: null, pausedIntervals: [], stopTimestamp: null },
    laps: [],
    logs: [],
    audit: []
  };
}

function fmtElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function getNow(state) {
  if (state.timer.status === "stopped" && state.timer.stopTimestamp) return state.timer.stopTimestamp;
  return Date.now();
}

function getElapsedMs(state) {
  if (state.timer.status === "setup" || !state.timer.startTimestamp) return 0;
  const now = getNow(state);
  let pausedTotal = 0;
  for (const p of state.timer.pausedIntervals) {
    const end = p.end != null ? p.end : now;
    pausedTotal += Math.max(0, end - p.start);
  }
  return Math.max(0, now - state.timer.startTimestamp - pausedTotal);
}

function latestSegmentAt(state, atMs) {
  let seg = state.targets[0];
  for (const s of state.targets) {
    if (s.atElapsedMs <= atMs) seg = s;
    else break;
  }
  return seg;
}

function currentTargets(state) {
  return latestSegmentAt(state, getElapsedMs(state));
}

function pushAudit(state, type, summary, detail, reportedElapsedMs, reportedTimestamp) {
  const nowElapsed = getElapsedMs(state);
  const nowTs = Date.now();
  state.audit.push({
    id: nowTs + "-" + Math.random().toString(36).slice(2, 7),
    loggedElapsedMs: nowElapsed,
    loggedTimestamp: nowTs,
    reportedElapsedMs: reportedElapsedMs != null ? reportedElapsedMs : nowElapsed,
    reportedTimestamp: reportedTimestamp != null ? reportedTimestamp : nowTs,
    type,
    summary,
    detail: detail || ""
  });
}

function performLap(state, atElapsedMs, auto) {
  const prev = state.laps.length ? state.laps[state.laps.length - 1].atElapsedMs : 0;
  const lap = { n: state.laps.length + 1, atElapsedMs, splitMs: atElapsedMs - prev, timestamp: Date.now(), auto: !!auto };
  state.laps.push(lap);
  pushAudit(
    state,
    "lap",
    auto ? "Lap " + lap.n + " auto-recorded" : "Lap " + lap.n + " recorded",
    "Split " + fmtElapsed(lap.splitMs),
    atElapsedMs,
    lap.timestamp
  );
  return lap;
}

// Inserts any auto-laps that are due. Safe to call repeatedly (idempotent per tick);
// catches up in a loop if the server was busy/asleep and missed one or more intervals.
function checkAutoLap(state) {
  if (state.timer.status !== "running") return false;
  if (!state.autoLap || !state.autoLap.enabled) return false;
  const intervalMin = Number(state.autoLap.intervalMinutes) || 0;
  if (intervalMin <= 0) return false;
  const intervalMs = intervalMin * 60000;
  let lastLapAt = state.laps.length ? state.laps[state.laps.length - 1].atElapsedMs : 0;
  const elapsed = getElapsedMs(state);
  let didLap = false;
  let guard = 0;
  while (elapsed - lastLapAt >= intervalMs && guard < 10000) {
    const lapAt = lastLapAt + intervalMs;
    performLap(state, lapAt, true);
    lastLapAt = lapAt;
    didLap = true;
    guard++;
  }
  return didLap;
}

function clampStr(v, max) {
  return (v == null ? "" : String(v)).slice(0, max);
}
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function applyAction(state, action) {
  const type = action && action.type;
  const payload = (action && action.payload) || {};

  switch (type) {
    case "setup": {
      state.setup.raceName = clampStr(payload.raceName, 200);
      state.setup.scheduledStart = clampStr(payload.scheduledStart, 60);
      state.setup.terrain = clampStr(payload.terrain, 30) || "trail";
      state.setup.startTemp = clampStr(payload.startTemp, 20);
      state.setup.tempUnit = payload.tempUnit === "C" ? "C" : "F";
      state.setup.conditions = clampStr(payload.conditions, 30) || "sunny";
      state.setup.notes = clampStr(payload.notes, 2000);
      state.autoLap = {
        enabled: !!(payload.autoLap && payload.autoLap.enabled),
        intervalMinutes: Math.max(1, num(payload.autoLap && payload.autoLap.intervalMinutes, 30))
      };
      if (state.timer.status === "setup" && payload.targets) {
        state.targets[0] = {
          atElapsedMs: 0,
          cal: num(payload.targets.cal, 0),
          carb: num(payload.targets.carb, 0),
          fluid: num(payload.targets.fluid, 0),
          electrolyte: num(payload.targets.electrolyte, 0)
        };
      }
      pushAudit(state, "setup", "Race setup saved", state.setup.raceName || "Untitled race");
      break;
    }

    case "start": {
      if (state.timer.status !== "setup") break;
      state.timer.status = "running";
      state.timer.startTimestamp = Date.now();
      pushAudit(state, "race_start", "Race started", state.setup.raceName || "");
      break;
    }

    case "pauseToggle": {
      if (state.timer.status === "running") {
        state.timer.status = "paused";
        state.timer.pausedIntervals.push({ start: Date.now(), end: null });
        pushAudit(state, "race_pause", "Race paused", "");
      } else if (state.timer.status === "paused") {
        const open = state.timer.pausedIntervals[state.timer.pausedIntervals.length - 1];
        if (open) open.end = Date.now();
        state.timer.status = "running";
        pushAudit(state, "race_resume", "Race resumed", "");
      }
      break;
    }

    case "lap": {
      if (state.timer.status !== "running" && state.timer.status !== "paused") break;
      performLap(state, getElapsedMs(state), false);
      break;
    }

    case "stop": {
      if (state.timer.status !== "running" && state.timer.status !== "paused") break;
      if (state.timer.status === "paused") {
        const open = state.timer.pausedIntervals[state.timer.pausedIntervals.length - 1];
        if (open && open.end == null) open.end = Date.now();
      }
      state.timer.status = "stopped";
      state.timer.stopTimestamp = Date.now();
      pushAudit(state, "race_stop", "Race completed", "Final time " + fmtElapsed(getElapsedMs(state)));
      break;
    }

    case "reset": {
      Object.assign(state, defaultState());
      break;
    }

    case "updateTargets": {
      const next = {
        cal: num(payload.cal, 0),
        carb: num(payload.carb, 0),
        fluid: num(payload.fluid, 0),
        electrolyte: num(payload.electrolyte, 0)
      };
      const cur = currentTargets(state);
      const changes = [];
      for (const k of ["cal", "carb", "fluid", "electrolyte"]) {
        if (next[k] !== cur[k]) changes.push(k + " " + cur[k] + "\u2192" + next[k]);
      }
      if (state.timer.status === "setup") {
        state.targets[0] = Object.assign({ atElapsedMs: 0 }, next);
      } else {
        const elapsed = getElapsedMs(state);
        const last = state.targets[state.targets.length - 1];
        if (last.atElapsedMs === elapsed) {
          state.targets[state.targets.length - 1] = Object.assign({ atElapsedMs: elapsed }, next);
        } else {
          state.targets.push(Object.assign({ atElapsedMs: elapsed }, next));
        }
      }
      if (changes.length) pushAudit(state, "target_change", "Targets updated", changes.join(", "));
      break;
    }

    case "updateConditions": {
      const temp = clampStr(payload.temp, 10);
      const unit = payload.unit === "C" ? "C" : "F";
      const cond = clampStr(payload.conditions, 30) || "sunny";
      const note = clampStr(payload.note, 500);
      let detail = cond;
      if (temp) detail += ", " + temp + "\u00b0" + unit;
      if (note) detail += " \u2014 " + note;
      pushAudit(state, "condition_change", "Conditions updated", detail);
      break;
    }

    case "logIntake": {
      const minutesAgo = Math.max(0, num(payload.minutesAgo, 0));
      const elapsedNow = getElapsedMs(state);
      const atElapsedMs = Math.max(0, elapsedNow - minutesAgo * 60000);
      const entry = {
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        atElapsedMs,
        timestamp: Date.now() - minutesAgo * 60000,
        calories: Math.max(0, num(payload.calories, 0)),
        carbs: Math.max(0, num(payload.carbs, 0)),
        fluidMl: Math.max(0, num(payload.fluidMl, 0)),
        electrolyteMg: Math.max(0, num(payload.electrolyteMg, 0)),
        note: clampStr(payload.note, 500)
      };
      state.logs.push(entry);
      state.logs.sort((a, b) => a.atElapsedMs - b.atElapsedMs);
      const parts = [];
      if (entry.calories) parts.push(entry.calories + " kcal");
      if (entry.carbs) parts.push(entry.carbs + "g carbs");
      if (entry.fluidMl) parts.push(entry.fluidMl + "mL fluid");
      if (entry.electrolyteMg) parts.push(entry.electrolyteMg + "mg electrolytes");
      pushAudit(
        state,
        "intake_log",
        "Intake logged",
        parts.join(", ") + (entry.note ? " \u2014 " + entry.note : ""),
        entry.atElapsedMs,
        entry.timestamp
      );
      break;
    }

    case "addNote": {
      const text = clampStr(payload.text, 1000).trim();
      if (!text) break;
      const minutesAgo = Math.max(0, num(payload.minutesAgo, 0));
      const elapsedNow = getElapsedMs(state);
      const atElapsedMs = Math.max(0, elapsedNow - minutesAgo * 60000);
      const atTimestamp = Date.now() - minutesAgo * 60000;
      pushAudit(state, "note", "Note", text, atElapsedMs, atTimestamp);
      break;
    }

    default:
      break;
  }

  return state;
}

module.exports = {
  defaultState,
  fmtElapsed,
  getNow,
  getElapsedMs,
  latestSegmentAt,
  currentTargets,
  pushAudit,
  performLap,
  checkAutoLap,
  applyAction
};
