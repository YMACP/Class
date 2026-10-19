import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskScheduler, TASK_SCHEDULE_LIMITS } from '../src/task-scheduler.js';
import { atomicJSON } from '../src/profile-store.js';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-schedule-test-'));
  const controllers = [], gates = [], errors = [], calls = [], runs = new Map(); let time = Date.parse('2026-10-19T08:00:00Z');
  const f = { root, calls, runs, errors, now:()=>time, advance:value=>{ time += value; },
    input:(extra={})=>({ name:'独立任务', description:'处理给定材料', goal:'产出可核实的结论', scheduledAt:new Date(time + 60000).toISOString(), timezone:'Asia/Shanghai', payload:{ taskMode:'auto', agentIds:['teacher','student'] }, ...extra }),
    gate() { let resolve; const promise = new Promise(done=>{resolve=done;}); gates.push(resolve); return { promise, resolve }; },
    async open(options={}) {
      const controller = await createTaskScheduler({ directory:root, now:()=>time, autoStart:false, lookupRun:id=>runs.get(id), onDue:async value=>{calls.push(value);runs.set(value.runId,{id:value.runId});}, onError:error=>errors.push(error), ...options });
      controllers.push(controller); return controller;
    },
  };
  t.after(async () => {
    for (const release of gates) release();
    await Promise.all(controllers.map(controller=>controller.close()));
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent); assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(resolved, { recursive:true, force:true });
  });
  return f;
}
async function waitFor(check) { const deadline=Date.now()+3000; while(!check()){if(Date.now()>deadline)throw Error('Timed out waiting for scheduler');await delay(5);} }

test('scheduled records reserve the final run ID and survive restart with exact timezone and independent snapshots', async t => {
  const f=await fixture(t), controller=await f.open(), id='run-'+randomUUID();
  const input=f.input({ id, runId:id, scheduledAt:'2026-10-19T16:01:00+08:00', payload:{taskMode:'custom-fixture',taskModeDefinition:{name:'模式',prompt:'完整\n提示词\n'},attachmentIds:['one']} });
  const created=await controller.create(input,{revision:0}), item=created.items[0];
  assert.equal(item.id,id);assert.equal(item.runId,id);assert.equal(item.scheduledAt,'2026-10-19T08:01:00.000Z');assert.equal(item.timezone,'Asia/Shanghai');
  assert.equal(item.status,'pending');assert.equal(created.revision,1);assert.equal(f.calls.length,0);
  created.items[0].payload.taskModeDefinition.prompt='changed outside'; input.payload.attachmentIds.push('other');
  assert.equal(controller.list().items[0].payload.taskModeDefinition.prompt,'完整\n提示词\n');assert.deepEqual(controller.list().items[0].payload.attachmentIds,['one']);
  const persisted=await fs.readFile(controller.filename,'utf8');await controller.close();
  const fresh=await f.open();assert.equal(await fs.readFile(fresh.filename,'utf8'),persisted);assert.equal(fresh.list().items[0].status,'pending');assert.equal(f.calls.length,0);
});

test('two due callbacks run independently only after durable reservation and concurrent ticks never duplicate them', async t => {
  const f=await fixture(t), gate=f.gate();let controller;
  controller=await f.open({onDue:async value=>{
    const disk=JSON.parse(await fs.readFile(controller.filename,'utf8')), saved=disk.items.find(item=>item.id===value.runId);
    assert.equal(saved.status,'dispatched');assert.equal(saved.runId,value.runId);assert.ok(saved.dispatchedAt);
    f.calls.push(value);await gate.promise;f.runs.set(value.runId,{id:value.runId});
  }});
  await controller.create(f.input());await controller.create(f.input({name:'第二个独立任务'}));f.advance(60000);
  await Promise.all([controller.tick(),controller.tick(),controller.tick()]);await waitFor(()=>f.calls.length===2);
  assert.equal(new Set(f.calls.map(call=>call.runId)).size,2);assert.ok(controller.list().items.every(item=>item.status==='dispatched'));
  await assert.rejects(controller.cancel(f.calls[0].runId),error=>error.status===409);await assert.rejects(controller.remove(f.calls[0].runId),error=>error.status===409);
  gate.resolve();await waitFor(()=>controller.list().items.every(item=>item.status==='started'));
  await controller.tick();assert.equal(f.calls.length,2);
});

test('overdue work at startup is missed while future work survives and manual rescheduling can run once', async t => {
  const f=await fixture(t), first=await f.open();await first.create(f.input());await first.create(f.input({name:'未来任务',scheduledAt:new Date(f.now()+120000).toISOString()}));
  await first.close();f.advance(70000);const fresh=await f.open(), missed=fresh.list().items[0], future=fresh.list().items[1];
  assert.equal(missed.status,'missed');assert.equal(future.status,'pending');assert.equal(f.calls.length,0);
  await fresh.tick();assert.equal(f.calls.length,0);
  await fresh.update(missed.id,{scheduledAt:new Date(f.now()+1000).toISOString(),name:'重新安排'});assert.equal(fresh.list().items[0].status,'pending');
  f.advance(1000);await fresh.tick();await waitFor(()=>fresh.list().items[0].status==='started');assert.equal(f.calls.length,1);
});

test('runtime reopen immediately dispatches elapsed work while a real restart still marks it missed', async t => {
  const f=await fixture(t),first=await f.open();
  await first.create(f.input({scheduledAt:new Date(f.now()+1000).toISOString()}));
  await first.create(f.input({name:'Future through migration',scheduledAt:new Date(f.now()+2000).toISOString()}));
  await first.close();f.advance(1500);
  const migrated=await f.open({markOverdueMissed:false,autoStart:true});
  await waitFor(()=>migrated.list().items[0].status==='started');assert.equal(migrated.list().items[1].status,'pending');assert.equal(f.calls.length,1);
  await migrated.close();f.advance(1000);
  const rebooted=await f.open();assert.deepEqual(rebooted.list().items.map(item=>item.status),['started','missed']);assert.equal(f.calls.length,1);
});

test('startup reconciles uncertain dispatch with existing run records and never automatically replays it', async t => {
  const f=await fixture(t), original=await f.open();for(let i=0;i<4;i++)await original.create(f.input({name:'任务'+i}));await original.close();
  const stored=JSON.parse(await fs.readFile(original.filename,'utf8')), at=new Date(f.now()).toISOString();
  for(const item of stored.items.slice(0,3)){item.status='dispatched';item.dispatchedAt=at;}
  await atomicJSON(original.filename,stored);
  f.runs.set(stored.items[0].id,{id:stored.items[0].id});f.runs.set(stored.items[3].id,{id:stored.items[3].id});
  const recovered=await f.open({lookupRun:id=>{if(id===stored.items[2].id)throw Error('lookup fixture failure');return f.runs.get(id);}});
  assert.deepEqual(recovered.list().items.map(item=>item.status),['started','interrupted','interrupted','started']);assert.equal(f.calls.length,0);
  await recovered.tick();assert.equal(f.calls.length,0);
  await assert.rejects(recovered.startNow(stored.items[2].id),/lookup fixture failure/);assert.equal(f.calls.length,0);
  await recovered.startNow(stored.items[1].id);await waitFor(()=>recovered.list().items[1].status==='started');assert.equal(f.calls.length,1);
});

test('dispatch failures use fixed public reasons and a created run is not retried after callback failure', async t => {
  const f=await fixture(t);let invocation=0;
  const controller=await f.open({onDue:async value=>{f.calls.push(value);invocation++;if(invocation===1)throw Error('SECRET-fixture-do-not-store');f.runs.set(value.runId,{id:value.runId});throw Error('crash after run creation');}});
  const id=(await controller.create(f.input())).items[0].id;await controller.startNow(id);await waitFor(()=>controller.list().items[0].status==='failed');
  assert.doesNotMatch(await fs.readFile(controller.filename,'utf8'),/SECRET-fixture-do-not-store/);
  await controller.startNow(id);await waitFor(()=>controller.list().items[0].status==='started');
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].runId,f.calls[1].runId);assert.equal(f.errors.length,2);
  await assert.rejects(controller.startNow(id),error=>error.status===409);assert.equal(f.calls.length,2);
});

test('failed atomic writes preserve prior records and cannot invoke work before reservation is stored', async t => {
  const f=await fixture(t);let rejectWrites=false;
  const controller=await f.open({writeJSON:async (...args)=>{if(rejectWrites)throw Error('disk fixture unavailable');return atomicJSON(...args);}});
  await controller.create(f.input());const before=await fs.readFile(controller.filename,'utf8');rejectWrites=true;
  await assert.rejects(controller.create(f.input()),/disk fixture unavailable/);assert.equal(controller.list().revision,1);assert.equal(controller.list().items.length,1);
  f.advance(60000);await assert.rejects(controller.tick(),/disk fixture unavailable/);assert.equal(f.calls.length,0);assert.equal(controller.list().items[0].status,'pending');
  assert.equal(await fs.readFile(controller.filename,'utf8'),before);
  rejectWrites=false;await controller.tick();await waitFor(()=>controller.list().items[0].status==='started');assert.equal(f.calls.length,1);
});

test('serialized mutations enforce optimistic revisions and cancel/remove never trigger model work', async t => {
  const f=await fixture(t), controller=await f.open();
  const results=await Promise.allSettled([controller.create(f.input({name:'甲'}),{revision:0}),controller.create(f.input({name:'乙'}),{revision:0})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
  await Promise.all([controller.create(f.input({name:'丙'})),controller.create(f.input({name:'丁'}))]);assert.equal(controller.list().revision,3);assert.equal(controller.list().items.length,3);
  const id=controller.list().items[0].id;await controller.cancel(id);assert.equal(controller.list().items[0].status,'cancelled');
  await assert.rejects(controller.startNow(id),error=>error.status===409);await assert.rejects(controller.update(id,{name:'不应编辑'}),error=>error.status===409);
  await controller.remove(id);assert.equal(controller.list().items.length,2);assert.equal(f.calls.length,0);
  await assert.rejects(controller.create(f.input({id:controller.list().items[0].id})),error=>error.status===409);
});

test('schedule validation rejects ambiguous dates, malformed IDs, timezone errors, hidden extra fields and oversized payloads', async t => {
  const f=await fixture(t), controller=await f.open(), cases=[
    {scheduledAt:'2026-10-20T09:00:00'}, {scheduledAt:'2026-02-30T09:00:00Z'}, {scheduledAt:'2026-10-20T24:00:00Z'}, {scheduledAt:new Date(f.now()).toISOString()},
    {timezone:'Not/A_Timezone'}, {timezone:'+08:00'}, {name:' '}, {description:''}, {goal:''}, {name:'x'.repeat(201)}, {description:'x'.repeat(12001)}, {goal:'x'.repeat(6001)},
    {id:'../profiles'}, {id:'run-'+randomUUID(),runId:'run-'+randomUUID()}, {apiKey:'SECRET-never-save'}, {payload:{large:'x'.repeat(TASK_SCHEDULE_LIMITS.payloadBytes)}}, {payload:{run:()=>{}}}, {payload:{n:Infinity}},
  ];
  for(const values of cases)await assert.rejects(controller.create(f.input(values)),error=>error.status===400);
  assert.equal(controller.list().items.length,0);assert.equal(controller.list().revision,0);assert.equal(f.calls.length,0);
  await assert.rejects(fs.readFile(controller.filename),error=>error.code==='ENOENT');
});

test('damaged stored records fail closed without overwriting evidence or starting callbacks', async t => {
  const f=await fixture(t), filename=path.join(f.root,'task-schedules.json'), original='{"version":1,"revision":0,"items":[{"id":"../escape"}]}';
  await fs.writeFile(filename,original,{mode:0o600});await assert.rejects(f.open(),/格式无效/);
  assert.equal(await fs.readFile(filename,'utf8'),original);assert.equal(f.calls.length,0);
});

test('live timer starts due work and close flushes dispatch bookkeeping without consuming future work', async t => {
  const f=await fixture(t), controller=await f.open({autoStart:true,now:Date.now});
  await controller.create(f.input({scheduledAt:new Date(Date.now()+600).toISOString()}));await waitFor(()=>controller.list().items[0].status==='started');assert.equal(f.calls.length,1);
  await controller.create(f.input({scheduledAt:new Date(Date.now()+60000).toISOString()}));await controller.close();
  assert.equal(controller.list().items[1].status,'pending');await assert.rejects(controller.tick(),error=>error.status===409);await assert.rejects(controller.create(f.input()),error=>error.status===409);
  assert.equal(f.calls.length,1);assert.deepEqual(JSON.parse(await fs.readFile(controller.filename,'utf8')).items,controller.list().items);
});
