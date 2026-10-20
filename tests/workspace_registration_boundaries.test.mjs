import assert from 'node:assert/strict';
import test from 'node:test';
import { registrationId } from '../web/js/registrationId.js';
import { refreshPersonReview, hasPersonInput, removeNewPerson } from '../web/js/schoolRegistrationModel.js';

test('ID uses available cryptographic capabilities and fails visibly without them', () => {
  assert.equal(registrationId({ randomUUID: () => 'native' }), 'native');
  assert.match(registrationId({ getRandomValues: bytes => bytes.fill(255) }), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.throws(() => registrationId({}), /当前输入已保留/);
  assert.throws(() => registrationId({ getRandomValues: () => { throw new Error('entropy'); } }), /entropy/);
  const fallback = { getRandomValues: bytes => crypto.getRandomValues(bytes) };
  assert.equal(new Set(Array.from({ length: 10000 }, () => registrationId(fallback))).size, 10000);
});
test('rename and candidate revisions invalidate confirmation; unique rename clears snapshot', () => {
  const existing = { key: 'a:1', id: 1, rev: 2, name: '甲', note: '一班' };
  const p = { key: 'new:x', name: '甲', note: '二班', confirm_distinct_person: true };
  const base = { people: [existing] }, model = { people: [existing, p] };
  refreshPersonReview(base, model, p);
  assert.deepEqual(p.same_name_candidates, [{ id: 1, rev: 2 }]);
  assert.equal(p.confirm_distinct_person, true);
  p.name = '乙'; refreshPersonReview(base, model, p);
  assert.deepEqual(p.same_name_candidates, []); assert.equal(p.confirm_distinct_person, false);
  p.name = '甲'; refreshPersonReview(base, model, p); p.confirm_distinct_person = true;
  existing.rev++; refreshPersonReview(base, model, p); assert.equal(p.confirm_distinct_person, false);
});
test('partial forms distinguish defaults from deliberate edits', () => {
  assert.equal(hasPersonInput(undefined), false);
  assert.equal(hasPersonInput({ gender: 'male' }, 'male'), false);
  for (const form of [{ note: '班级' }, { jersey_no: '8' }, { name: '甲' }, { gender: 'female' }])
    assert.equal(hasPersonInput(form), true);
});
test('remove cleans every inactive reference, never active or locked entries', () => {
  const model = { people: [{ key: 'new:x' }, { key: 'a:1' }], categories: [{ id: 1 }, { id: 2 }], projects: [
    { category_id: 1, choice: 'withdrawn', members: [{ athlete_key: 'new:x' }], captain_key: 'new:x', athlete_key: '' },
    { category_id: 2, choice: 'not_participating', members: [], captain_key: '', athlete_key: 'new:x' }] };
  const active = structuredClone(model); active.projects[0].choice = 'participate';
  assert.throws(() => removeNewPerson(active, 'new:x'), /先从项目/); assert.equal(active.people.length, 2);
  const locked = structuredClone(model); locked.categories[0].roster_locked_reason = 'frozen';
  assert.throws(() => removeNewPerson(locked, 'new:x'), /冻结/); assert.equal(locked.people.length, 2);
  removeNewPerson(model, 'new:x');
  assert.deepEqual(model.people, [{ key: 'a:1' }]);
  assert.deepEqual(model.projects.map(p => [p.members, p.captain_key, p.athlete_key]), [[[], '', ''], [[], '', '']]);
  assert.throws(() => removeNewPerson(model, 'a:1'), /尚未提交/);
});
