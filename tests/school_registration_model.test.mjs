import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, submission, reconcile, eligibility } from '../web/js/schoolRegistrationModel.js';
import { setPendingRequestScope, writePendingRequest, readPendingRequest, removePendingRequest, capturePendingRequestScope } from '../web/js/pendingRequests.js';

const base = { base_hash: 'v1', event_identity: { event_id: 1, event_uuid: 'event-1', deployment_id: 'host-1' },
  people: [{ id: 1, key: 'a:1', name: '甲', gender: 'male', jersey_no: '8', note: '', rev: 1 },
    { id: 2, key: 'a:2', name: '乙', gender: 'male', jersey_no: '', note: '', rev: 1 }],
  categories: [{ id: 1, name: '男团', kind: 'team', gender: 'male' }, { id: 2, name: '男单', kind: 'individual', gender: 'male' }],
  projects: [{ category_id: 1, choice: 'participate', members: [{ athlete_key: 'a:1', jersey_no: '9' }], captain_key: 'a:1' },
    { category_id: 2, choice: 'unresolved', members: [], athlete_key: '', seed_no: null }] };

test('only affected projects are submitted, project jersey does not edit athlete profile', () => {
  const local = clone(base);
  local.projects[0].members[0].jersey_no = '10';
  const payload = submission(base, local);
  assert.equal(payload.people.length, 0);
  assert.equal(payload.projects.length, 1);
  assert.equal(local.people[0].jersey_no, '8');
  assert.equal(payload.event_identity.event_uuid, 'event-1');
});

test('eligibility uses projected occupancy, so moving frees the old project', () => {
  const local = clone(base);
  assert.match(eligibility(local.people[0], local.categories[1], local), /已参加男团/);
  local.projects[0].members = [{ athlete_key: 'a:2', jersey_no: '' }];
  assert.equal(eligibility(local.people[0], local.categories[1], local), '');
  local.people[0].gender = 'female';
  assert.match(eligibility(local.people[0], local.categories[1], local), /性别/);
});

test('non-overlapping concurrent changes merge with latest revisions and untouched project', () => {
  const local = clone(base), latest = clone(base);
  local.people[0].note = '本机'; latest.people[1].note = '远端'; latest.people[0].rev = 2;
  latest.projects[1].choice = 'not_participating';
  const { merged, conflicts } = reconcile(base, local, latest);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.people[0].note, '本机'); assert.equal(merged.people[0].rev, 2);
  assert.equal(merged.people[1].note, '远端'); assert.equal(merged.projects[1].choice, 'not_participating');
});

test('overlapping edits and deleted identities require explicit resolution', () => {
  const local = clone(base), latest = clone(base);
  local.people[0].note = '本机'; latest.people[0].note = '远端';
  local.people[1].note = '待保存'; latest.people.pop();
  const { conflicts } = reconcile(base, local, latest);
  assert.equal(conflicts.length, 2);
  assert.equal(conflicts[1].remote, undefined);
});

test('formal reconciliation preserves unmerged table and unadded personnel input', () => {
  const local = clone(base), latest = clone(base);
  local.importText = '项目\t运动员\n男团\t新同学';
  local.newPersonForms = { people: { name: '未加入', note: '二班' } };
  const { merged } = reconcile(base, local, latest);
  assert.equal(merged.importText, local.importText);
  assert.deepEqual(merged.newPersonForms, local.newPersonForms);
  merged.newPersonForms.people.name = '编辑';
  assert.equal(local.newPersonForms.people.name, '未加入');
});

test('only exact pending submissions are retained, isolated by account, deployment and event', () => {
  const storage = new Map();
  globalThis.localStorage = { get length() { return storage.size; }, key: i => [...storage.keys()][i], getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
  const pending = { request_uid: 'original', people: [], preview_hash: 'p', base_hash: 'v1' };
  setPendingRequestScope({ username: 'admin' }, base.event_identity);
  assert.equal(writePendingRequest('school-registration:1:1', { base, model: base }), false);
  writePendingRequest('school-registration:1:1', pending);
  assert.deepEqual(readPendingRequest('school-registration:1:1'), pending);
  assert.deepEqual(JSON.parse([...storage.values()][0]), pending, 'no form model is stored');
  for (const [user, identity] of [[{ username: 'other' }, base.event_identity], [{ username: 'admin' }, { ...base.event_identity, event_uuid: 'event-2' }], [{ username: 'admin' }, { ...base.event_identity, deployment_id: 'host-2' }]]) {
    setPendingRequestScope(user, identity); assert.equal(readPendingRequest('school-registration:1:1'), null);
  }
  setPendingRequestScope({ username: 'admin' }, base.event_identity);
  assert.equal(removePendingRequest('school-registration:1:1'), true);
  assert.equal(readPendingRequest('school-registration:1:1'), null);
});

test('upgrade ignores old unsaved forms while retaining their original in-flight packet', () => {
  const storage = new Map();
  globalThis.localStorage = { get length() { return storage.size; }, key: i => [...storage.keys()][i], getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
  setPendingRequestScope({ username: 'admin' }, base.event_identity);
  const oldKey = 'stss_draft:admin:host-1:event-1:school-registration:1:1';
  storage.set(oldKey, JSON.stringify({ values: { base, model: base, sharedRev: 7 } }));
  assert.equal(readPendingRequest('school-registration:1:1'), null);
  const pending = { request_uid: 'legacy-packet', shared_draft_rev: 7, preview_hash: 'old-hash' };
  storage.set(oldKey, JSON.stringify({ values: { base, model: base, pending } }));
  assert.deepEqual(readPendingRequest('school-registration:1:1'), pending);
  removePendingRequest('school-registration:1:1');
  assert.equal(readPendingRequest('school-registration:1:1'), null);
  assert.deepEqual(JSON.parse(storage.get(oldKey)).values.pending, pending);
  assert.equal(storage.get('stss_pending:admin:host-1:event-1:school-registration:1:1:done:legacy-packet'), '1');
});

test('completion in an old page cannot retire the new account packet', () => {
  const storage = new Map();
  globalThis.localStorage = { get length() { return storage.size; }, key: i => [...storage.keys()][i],
    getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
  setPendingRequestScope({ username: 'first' }, base.event_identity);
  const oldScope = capturePendingRequestScope(), old = { request_uid: 'first-uid' };
  assert.equal(writePendingRequest('scope-test', old, oldScope), true);
  setPendingRequestScope({ username: 'second' }, base.event_identity);
  const current = { request_uid: 'second-uid' };
  assert.equal(writePendingRequest('scope-test', current), true);
  removePendingRequest('scope-test', oldScope);
  assert.equal(readPendingRequest('scope-test', oldScope), null);
  assert.deepEqual(readPendingRequest('scope-test'), current);
});
