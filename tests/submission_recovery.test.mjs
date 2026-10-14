import test from 'node:test';
import assert from 'node:assert/strict';
import { api, setApiEventContext } from '../web/js/api.js';
import { buildIndividualPayload } from '../web/js/submit.js';

globalThis.localStorage = { getItem: () => 'test-token' };

test('读取提交响应途中断网仍标记为网络错误，供恢复查询处理', async () => {
  globalThis.fetch = async () => ({ ok: true, text: async () => { throw new TypeError('connection closed'); } });
  await assert.rejects(api.post('/api/scoring/submit', {}), error => error.offline && error.status === 0);
});

test('服务端拒绝提交保留具体错误，不误判为断网', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 409,
    text: async () => JSON.stringify({ code: 'version_conflict', message: '版本变化' }) });
  await assert.rejects(api.post('/api/scoring/submit', {}), error => !error.offline && error.code === 'version_conflict');
});

test('离线恢复后的赛事标识随提交发送，正式更正原因在重试中保持不变', async () => {
  const identity = { event_id: 1, event_uuid: 'event-one', deployment_id: 'deployment-one' };
  setApiEventContext(identity);
  let observed;
  globalThis.fetch = async (url, options) => {
    observed = options;
    return { ok: true, text: async () => '{"duplicate":true}' };
  };
  const draft = { event_identity: identity, uid: 'same-request', participation_id: 1, base_version: 1,
    result_status: 'normal', result_value: 20, error_count: 0, reason: '裁判复核' };
  const payload = buildIndividualPayload(draft);
  draft.reason = '尚未提交的其他输入';
  assert.equal(buildIndividualPayload(draft), payload);
  await api.post('/api/scoring/individual', payload);
  assert.equal(observed.headers['X-Deployment-ID'], identity.deployment_id);
  assert.equal(observed.headers['X-Event-UUID'], identity.event_uuid);
  assert.equal(JSON.parse(observed.body).reason, '裁判复核');
});
