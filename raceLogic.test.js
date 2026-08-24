"use strict";
const assert = require("assert");
const rl = require("./raceLogic.js");

// ---- fake clock ----
let fakeNow = new Date("2026-08-24T10:00:00Z").getTime();
const realDateNow = Date.now;
Date.now = () => fakeNow;
function advance(ms) { fakeNow += ms; }
function minutes(n) { return n * 60000; }

let failures = 0;
function check(name, cond) {
  if (!cond) { failures++; console.error("FAIL:", name); }
  else console.log("ok  -", name);
}

// ---- test 1: basic start/elapsed ----
let s = rl.defaultState();
rl.applyAction(s, { type: "setup", payload: { raceName: "Test 100", targets: { cal: 250, carb: 60, fluid: 500, electrolyte: 500 } } });
check("setup sets race name", s.setup.raceName === "Test 100");
check("setup sets initial target segment", s.targets[0].cal === 250);

rl.applyAction(s, { type: "start" });
check("status running after start", s.timer.status === "running");
advance(minutes(60));
check("elapsed after 60 min is 3600000", rl.getElapsedMs(s) === minutes(60));

// ---- test 2: pause freezes elapsed ----
rl.applyAction(s, { type: "pauseToggle" });
check("status paused", s.timer.status === "paused");
const elapsedAtPause = rl.getElapsedMs(s);
advance(minutes(10));
check("elapsed frozen during pause", rl.getElapsedMs(s) === elapsedAtPause);
rl.applyAction(s, { type: "pauseToggle" });
check("status running again after resume", s.timer.status === "running");
advance(minutes(5));
check("elapsed resumes counting (65 min total)", rl.getElapsedMs(s) === minutes(65));

// ---- test 3: target segments don't retroactively change past ----
const expectedBefore = (() => {
  // expected cumulative cal at 65 min with flat 250/hr = 250 * 65/60
  return 250 * (65 / 60);
})();
function expectedCumulativeRate(state, key, atMs) {
  let total = 0;
  const segs = state.targets;
  for (let i = 0; i < segs.length; i++) {
    const segStart = segs[i].atElapsedMs;
    if (segStart >= atMs) break;
    const segEnd = i + 1 < segs.length ? Math.min(segs[i + 1].atElapsedMs, atMs) : atMs;
    if (segEnd <= segStart) continue;
    total += segs[i][key] * ((segEnd - segStart) / 3600000);
  }
  return total;
}
check("expected cal at 65min matches flat rate", Math.abs(expectedCumulativeRate(s, "cal", minutes(65)) - expectedBefore) < 0.001);

rl.applyAction(s, { type: "updateTargets", payload: { cal: 300, carb: 60, fluid: 500, electrolyte: 500 } });
check("target segment appended, not replaced", s.targets.length === 2);
check("new segment starts at current elapsed (65min)", s.targets[1].atElapsedMs === minutes(65));
check("past expected value unchanged after target change", Math.abs(expectedCumulativeRate(s, "cal", minutes(65)) - expectedBefore) < 0.001);

advance(minutes(60)); // now at 125 min elapsed, 60 of those min at new 300/hr rate
const expectedAt125 = expectedBefore + 300 * 1; // + 300/hr * 1hr
check("expected cal at 125min uses new rate only after change", Math.abs(expectedCumulativeRate(s, "cal", minutes(125)) - expectedAt125) < 0.001);

// ---- test 4: intake logging + backdating ----
rl.applyAction(s, { type: "logIntake", payload: { calories: 150, carbs: 30, fluidMl: 300, electrolyteMg: 100, minutesAgo: 5 } });
const lastLog = s.logs[s.logs.length - 1];
check("logIntake records correct backdated elapsed", lastLog.atElapsedMs === minutes(125) - minutes(5));
const lastAudit = s.audit[s.audit.length - 1];
check("audit reportedElapsedMs matches backdated log time", lastAudit.reportedElapsedMs === lastLog.atElapsedMs);
check("audit loggedElapsedMs is current race time, not backdated", lastAudit.loggedElapsedMs === minutes(125));

// ---- test 5: note ----
rl.applyAction(s, { type: "addNote", payload: { text: "Runner feeling strong", minutesAgo: 0 } });
const noteAudit = s.audit[s.audit.length - 1];
check("note recorded with correct type", noteAudit.type === "note");
check("note detail stored", noteAudit.detail === "Runner feeling strong");

// ---- test 6: manual lap ----
rl.applyAction(s, { type: "lap" });
check("manual lap recorded", s.laps.length === 1 && s.laps[0].auto === false);
check("manual lap split equals full elapsed since no prior laps", s.laps[0].splitMs === minutes(125));

// ---- test 7: auto lap catch-up ----
let s2 = rl.defaultState();
rl.applyAction(s2, { type: "setup", payload: { raceName: "Auto Lap Test", autoLap: { enabled: true, intervalMinutes: 10 }, targets: { cal: 200, carb: 50, fluid: 400, electrolyte: 400 } } });
check("autoLap enabled saved", s2.autoLap.enabled === true && s2.autoLap.intervalMinutes === 10);
rl.applyAction(s2, { type: "start" });
advance(minutes(35)); // server was "asleep" for 35 minutes, should catch up 3 auto laps (10,20,30)
const didLap = rl.checkAutoLap(s2);
check("checkAutoLap reports laps were added", didLap === true);
check("3 auto laps inserted after 35 min at 10 min interval", s2.laps.length === 3);
check("auto laps are evenly spaced", s2.laps[0].atElapsedMs === minutes(10) && s2.laps[1].atElapsedMs === minutes(20) && s2.laps[2].atElapsedMs === minutes(30));
check("auto laps flagged auto:true", s2.laps.every(l => l.auto === true));
check("no auto lap yet for the 30-40 window since elapsed is 35", s2.laps.length === 3);
// calling again immediately should not double-insert
const didLapAgain = rl.checkAutoLap(s2);
check("checkAutoLap is idempotent within same elapsed window", didLapAgain === false && s2.laps.length === 3);

// ---- test 8: stop freezes elapsed even as real time advances ----
rl.applyAction(s2, { type: "stop" });
const elapsedAtStop = rl.getElapsedMs(s2);
advance(minutes(100));
check("elapsed frozen after stop despite time passing", rl.getElapsedMs(s2) === elapsedAtStop);

// ---- test 9: reset clears everything ----
rl.applyAction(s2, { type: "reset" });
check("reset returns to setup status", s2.timer.status === "setup");
check("reset clears laps", s2.laps.length === 0);
check("reset clears audit", s2.audit.length === 0);

// ---- test 10: start is a no-op if already running/stopped ----
let s3 = rl.defaultState();
rl.applyAction(s3, { type: "start" });
const startTs = s3.timer.startTimestamp;
advance(minutes(1));
rl.applyAction(s3, { type: "start" }); // should be ignored
check("second start() call is ignored", s3.timer.startTimestamp === startTs);

Date.now = realDateNow;

console.log("\n" + (failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
