/* Transport failures must retain the exact private request, including 404/426.
   The memory store/lock below is single-process test infrastructure; actual
   storage concurrency is covered by communication_storage.browser.test.mjs. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setApiEventContext,setApiUser,setToken} from '../web/js/api.js';
import {localStore,setStoreUser} from '../web/js/store.js';
import {sendCandidate,performDecision,pendingDecision} from '../web/js/resultReviewModel.js';
const values=new Map();
globalThis.localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),
  removeItem:k=>values.delete(k),key:i=>[...values.keys()][i]??null,get length(){return values.size;}};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name,_options,run)=>run()}}});
const identity={event_id:1,event_uuid:'recovery-event',deployment_id:'recovery-deployment'};
const user={id:77,username:'recovery-fixture'};
const reset=()=>{values.clear();setToken('fixture-token');setApiUser(user);setApiEventContext(identity);setStoreUser(user);};
const error=status=>new Response(JSON.stringify({code:'fixture_failure',message:'Retain original',outcome:'not_committed'}),{status});

for(const status of [404,426])test(`candidate ${status} never releases or replaces its original UID`,async()=>{
  reset();const calls=[];
  const draft={key:`candidate-${status}`,kind:'match',event_identity:identity,base_version:0,
    uid:`original-${status}`,status:'submitting',payload:{payload_schema:3,submission_uid:`original-${status}`,
      subject_kind:'match',subject_id:1,payload:{event_identity:identity,base_version:0}}};
  const original=structuredClone(draft.payload);
  globalThis.fetch=async(path,options)=>{calls.push({path,method:options.method,body:options.body});return error(status);};
  await assert.rejects(sendCandidate(draft),e=>e.status===status);
  assert.equal((await localStore.get(draft.key)).submission_unknown,true);
  await assert.rejects(sendCandidate(draft),e=>e.status===status);
  assert.deepEqual((await localStore.get(draft.key)).payload,original);
  assert.deepEqual(calls.map(c=>c.method),['POST','GET']);
  assert.equal(calls[1].path,`/api/candidate-receipts/${draft.uid}`);
  assert.equal(JSON.parse(calls[0].body).submission_uid,draft.uid);
});

test('unknown decision keeps original action, reason and UID when user requests a different decision',async()=>{
  reset();const candidate={id:'a'.repeat(32),revision:2,base_version:1,candidate_hash:'b'.repeat(64)};
  const calls=[];
  globalThis.fetch=async(path,options)=>{
    calls.push({path,method:options.method,body:options.body});
    return options.method==='GET'?new Response('{"found":false}'):error(404);
  };
  await assert.rejects(performDecision(candidate,'approve','Original reason',true),e=>e.status===404);
  const original=structuredClone((await pendingDecision(candidate)).payload);
  globalThis.fetch=async(path,options)=>{calls.push({path,method:options.method,body:options.body});return error(426);};
  await assert.rejects(performDecision(candidate,'return','Different reason'),e=>e.status===426);
  const retained=await pendingDecision(candidate);
  assert.equal(retained.submission_unknown,true);assert.deepEqual(retained.payload,original);
  assert.equal(original.action,'approve');assert.equal(original.reason,'Original reason');
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
  assert.equal(calls.at(-1).path,`/api/review-receipts/${original.decision_uid}`);
});

test('a definite initial validation rejection releases the request for an explicit new edit',async()=>{
  reset();const draft={key:'definite-rejection',kind:'match',event_identity:identity,base_version:0,
    uid:'rejected-original',status:'submitting',payload:{payload_schema:3,submission_uid:'rejected-original'}};
  globalThis.fetch=async()=>error(400);
  await assert.rejects(sendCandidate(draft),e=>e.status===400&&e.request_released===true);
  assert.equal(await localStore.get(draft.key),null);
});
