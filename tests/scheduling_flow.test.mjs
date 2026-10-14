import assert from 'node:assert/strict';
import { defaultFlow, flowPreview, flowStages, inferFlow, groupName } from '../web/js/schedulingFlow.js';
const flow=defaultFlow(8);
assert.deepEqual(flowPreview(flow,8).pairs,[['A组第1名','B组第2名'],['B组第1名','A组第2名']]);
assert.equal(flowPreview(flow,8).total,16);
assert.equal(flowPreview({...flow,legs:2},8).total,28);
assert.equal(flowPreview({...flow,third:false},8).total,15);
assert.equal(flowPreview({...flow,format:'league'},8).total,28);
assert.equal(flowPreview({...flow,format:'knockout'},6).total,6);
assert.equal(flowPreview({...flow,format:'knockout'},3).bronze,false);
assert.deepEqual(flowPreview({...flow,groups:4},10).sizes,[3,3,2,2]);
assert.throws(()=>flowPreview({...flow,groups:4,assign:'sequential'},10));
assert.throws(()=>flowPreview({...flow,groups:16},8));
assert.throws(()=>flowPreview(flow,1));
assert.deepEqual(inferFlow(flowStages(flow,8),8),flow);
const custom=flowStages(flow,8); custom[0].params.pools=[{name:'特别组',members:[0,2]}];
assert.equal(inferFlow(custom,8),null);
const reordered=flowStages(flow,8); reordered[1].params.sources.reverse();
assert.equal(inferFlow(reordered,8),null);
console.log('PASS: 常用流程场次、交叉配对、轮空、无效分组、旧方案识别');

const drawFlow = { ...flow, groups: 3, draw_id: 7, draw_sizes: [4, 3, 3] };
assert.deepEqual(flowPreview(drawFlow, 10).sizes, [4, 3, 3]);
assert.equal(flowPreview(drawFlow, 10).total, 18);
assert.deepEqual(inferFlow(flowStages(drawFlow, 10), 10), drawFlow);
assert.throws(() => flowPreview(drawFlow, 9));
assert.equal(flowPreview({ ...drawFlow, draw_sizes: [6, 2, 2] }, 10).total, 23);
console.log('PASS: 任意小组数量、抽签分组人数、固定抽签配置回显与报名变化拦截');

for (let groups = 2; groups <= 54; groups++) {
  const preview = flowPreview({ ...flow, groups }, groups * 2);
  assert.equal(new Set(preview.sources.map((s) => `${s.pool}:${s.rank}`)).size, groups * 2);
  for (const [left, right] of preview.pairs) {
    if (left === '轮空' || right === '轮空') continue;
    assert.notEqual(left.split('组')[0], right.split('组')[0], `${groups} 组时首轮不得同组相遇`);
  }
}
assert.deepEqual(flowPreview({ ...flow, groups: 4 }, 8).sources.map((s) => s.pool), [0, 1, 2, 3, 0, 1, 2, 3]);
console.log('PASS: 超过 26 组晋级签位无重复、淘汰首轮同组回避、原交叉顺序保留');

const singleGroup = { ...flow, groups: 1, third: false };
assert.deepEqual(flowPreview(singleGroup, 4).sizes, [4]);
assert.deepEqual(flowPreview(singleGroup, 4).pairs, [['A组第1名', 'A组第2名']]);
assert.equal(flowPreview(singleGroup, 4).total, 7);
assert.deepEqual(inferFlow(flowStages(singleGroup, 4), 4), singleGroup);
const singletonGroups = { ...flow, groups: 4, qualifiers: 1, draw_id: 8, draw_sizes: [1, 1, 1, 1] };
assert.equal(flowPreview(singletonGroups, 4).roundRobin, 0);
assert.equal(flowPreview(singletonGroups, 4).total, 4);
assert.deepEqual(inferFlow(flowStages(singletonGroups, 4), 4), singletonGroups);
const oneSchool = { ...flow, groups: 1, qualifiers: 1 };
assert.equal(flowPreview(oneSchool, 1).total, 0);
assert.deepEqual(flowPreview(oneSchool, 1).pairs, []);
assert.deepEqual([groupName(0), groupName(25), groupName(26), groupName(51), groupName(52)], ['A组', 'Z组', 'AA组', 'AZ组', 'BA组']);
assert.throws(() => flowPreview({ ...flow, groups: 0 }, 4));
assert.throws(() => flowPreview({ ...flow, groups: 1.5 }, 4));
assert.throws(() => flowPreview({ ...singletonGroups, draw_sizes: [0, 2, 1, 1] }, 4));
console.log('PASS: 单组、单校小组、仅一校的预览与旧方案识别、连续小组名称');

