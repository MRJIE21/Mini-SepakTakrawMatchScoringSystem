import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRules, ruleForSet, setsToWin, winner, legalScore, DEFAULT_RULES, sameRules } from '../web/js/teamRules.js';
import { summarize, addPoint, undoEvent } from '../web/js/scoring.js';
const vectors = JSON.parse(readFileSync(new URL('team_rules_vectors.json', import.meta.url)));
let count = 0;
for (const vector of vectors) for (const [home, away, expected, legal] of vector.cases) {
  assert.equal(winner(home, away, vector.rule), expected, JSON.stringify([vector.rule, home, away]));
  assert.equal(legalScore(home, away, vector.rule), legal);
  count++;
}
for (const maximum of [1, 3, 5, 7, 9]) {
  const rules = normalizeRules(); rules.max_sets = maximum;
  rules.deciding = { mode: 'fixed_deuce', target_points: 11, deuce_points: 13 };
  assert.equal(setsToWin(rules), (maximum + 1) / 2);
  for (let no = 1; no <= maximum; no++) assert.deepEqual(ruleForSet(rules, no), no === maximum ? rules.deciding : rules.regular);
}
for (const value of [0, 2, 4, 10, -1, true, '3']) assert.throws(() => normalizeRules({ ...DEFAULT_RULES, max_sets: value }));
for (const patch of [{ target_points: 0 }, { target_points: 100 }, { win_by: true }, { win_by: 3 }, { point_cap: 14 }, { point_cap: 1000 }, { other: 1 }])
  assert.throws(() => normalizeRules({ ...DEFAULT_RULES, regular: { ...DEFAULT_RULES.regular, ...patch } }));
for (const value of [-1, true, 1.5, '15', null, 2147483648]) assert.equal(legalScore(value, 0, DEFAULT_RULES.regular), false);
const changed = normalizeRules(); changed.regular.target_points = 9;
assert.equal(normalizeRules().regular.target_points, 15);
assert.ok(sameRules(DEFAULT_RULES, normalizeRules()));
console.log(`PASS: ${count} shared terminal vectors, five formats, deciding sets, strict parameters and immutable defaults`);
for (const maximum of [1, 3, 5, 7, 9]) {
  const rules = normalizeRules(); rules.max_sets = maximum;
  const events = [];
  for (let no = 1; no <= setsToWin(rules); no++) for (let point = 0; point < 15; point++) {
    const event = addPoint(events, 'home', summarize(events, rules)); assert.ok(event); events.push(event);
  }
  assert.equal(summarize(events, rules).matchOver, true);
  assert.equal(addPoint(events, 'away', summarize(events, rules)), null);
  events.push(undoEvent(events));
  assert.equal(summarize(events, rules).matchOver, false);
  assert.deepEqual(summarize(events, rules).liveScore, [14, 0]);
}
for (const vector of vectors) for (const [home, away, expected, legal] of vector.cases) {
  if (!legal || !expected || home > 50) continue;
  const rules = normalizeRules(); rules.max_sets = 1; rules.regular = vector.rule;
  const events = []; let h = 0, a = 0;
  while (h < home || a < away) {
    const side = h < home && (a >= away || h <= a) ? 'home' : 'away';
    const event = addPoint(events, side, summarize(events, rules)); assert.ok(event);
    events.push(event); if (side === 'home') h++; else a++;
  }
  assert.equal(summarize(events, rules).matchOver, true);
  assert.deepEqual(summarize(events, rules).liveScore, [home, away]);
}
console.log('PASS: full replay in all five formats, terminal score vectors and undo reopening');
