import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrincipalManager, PrincipalSnapshot } from '../src/principal-manager.js';
import { createClassServer } from '../src/web-server.js';
import { ModelClient } from '../src/agents.js';
import { taskModePrompt } from '../src/task-mode.js';
import { WEB_PENTEST_PROMPT } from '../src/web-pentest-prompt.js';

async function fixture(t) {
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'class-principal-')),historyDir=path.join(root,'history');
  const run={id:`run-${randomUUID()}`,task:'原始课堂问题',status:'running',events:[],blackboard:[]},directory=path.join(historyDir,run.id);
  await fs.mkdir(directory,{recursive:true});const cleanup=[];
  t.after(async()=>{for(const finish of cleanup)await finish();assert.equal(path.dirname(await fs.realpath(root)),parent);assert.equal((await fs.lstat(root)).isSymbolicLink(),false);await fs.rm(root,{recursive:true,force:true});});
  return {root,historyDir,run,directory,cleanup:finish=>cleanup.push(finish)};
}
async function until(check){for(let i=0;i<120;i++){const value=await check();if(value)return value;await delay(25);}throw Error('principal fixture timeout');}
function sendText(res,protocol,value){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(protocol==='messages'?{stop_reason:'end_turn',content:[{type:'text',text:value}]}:protocol==='responses'?{id:'response-fixture',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:value}]}]}:{choices:[{finish_reason:'stop',message:{role:'assistant',content:value}}]}));}
function sendTool(res,protocol,name,args){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(protocol==='messages'?{stop_reason:'tool_use',content:[{type:'tool_use',id:'fixture-read',name,input:args}]}:protocol==='responses'?{id:'response-tool',status:'completed',output:[{type:'function_call',id:'fixture-fc',call_id:'fixture-read',name,arguments:JSON.stringify(args)}]}:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{type:'function',id:'fixture-read',function:{name,arguments:JSON.stringify(args)}}]}}]}));}

test('principal uses only the frozen task mode and auto keeps its original prompt', async t => {
  let captured;
  t.mock.method(ModelClient.prototype, 'json', async function(system, input, signal, options) {
    captured = { system, input, options }; return { answer: '根据冻结记录汇报。' };
  });
  for (const taskMode of [undefined, 'auto', 'web_pentest']) {
    const f = await fixture(t); if (taskMode !== undefined) f.run.taskMode = taskMode;
    let release; const waiting = new Promise(resolve => { release = resolve; });
    const manager = new PrincipalManager({ historyDir: f.historyDir, beforeSnapshot: () => waiting });
    f.cleanup(() => manager.close());
    const report = manager.ask(f.run, { id: 'p', name: '校长' }, { protocol: 'chat', model: 'fixture', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1' }, '当前有哪些已验证和待验证项？');
    f.run.taskMode = taskMode === 'web_pentest' ? 'auto' : 'web_pentest'; release();
    const saved = await until(async () => { const value = await manager.get(f.run.id, report.id); return ['completed', 'failed'].includes(value.status) && value; });
    assert.equal(saved.status, 'completed');
    const suffix = taskModePrompt(taskMode, 'principal'), original = suffix ? captured.system.slice(0, -suffix.length) : captured.system;
    assert.ok(captured.system.endsWith(suffix));
    assert.equal(createHash('sha256').update(original).digest('hex'), 'aa18a7f30f486ce80684e86f8c451e2732af37fcfe40a13a0e53cf5dfb223114');
    assert.deepEqual(captured.options.tools.map(item => item.name), ['principal_list_context', 'principal_read_context', 'principal_search_context', 'context_read']);
    assert.equal(captured.input.classroom.task, '原始课堂问题');
    if (taskMode === 'web_pentest') {
      assert.equal(captured.system.split(WEB_PENTEST_PROMPT).length - 1, 1, 'principal must receive the full approved text exactly once');
      assert.match(suffix.slice(suffix.indexOf(WEB_PENTEST_PROMPT) + WEB_PENTEST_PROMPT.length), /本次调用角色与阶段：/);
    }
    assert.equal(f.run.status, 'running'); assert.deepEqual(f.run.blackboard, []);
  }
});

test('snapshot reads old full records, excludes future bytes and other runs, and preserves UTF-8 page boundaries',async t=>{
  const f=await fixture(t),original='旧证据-起点\n'+'中文连续文字'.repeat(1000)+'\n旧证据-终点';
  await fs.writeFile(path.join(f.directory,'journal.jsonl'),original);await fs.mkdir(path.join(f.directory,'outputs'));await fs.writeFile(path.join(f.directory,'outputs','old-result.txt'),'很早的完整输出');
  const snapshot=new PrincipalSnapshot({...f});f.run.task='之后的新问题';f.run.blackboard.push({content:'future'});
  await fs.appendFile(path.join(f.directory,'journal.jsonl'),'未来记录不应可读');await fs.writeFile(path.join(f.directory,'outputs','future.txt'),'future');
  let output='',offset=0;do{const page=await snapshot.read({source:'journal',offset,limit:19});assert.ok(!page.output.includes('\ufffd'));output+=page.output;offset=page.nextOffset;}while(offset!==null);
  assert.equal(output,original);assert.equal(snapshot.classroom.task,'原始课堂问题');
  assert.equal((await snapshot.read({source:'output:old-result'})).output,'很早的完整输出');
  await assert.rejects(snapshot.read({source:'output:future'}));await assert.rejects(snapshot.read({source:'../other-run/journal.jsonl'}));await assert.rejects(snapshot.execute('shell',{command:'anything'}));
  assert.ok(snapshot.manifest().warnings.some(value=>value.includes('图片/PDF')));
});

test('search pagination retains more than one page of same-page matches and Chinese phrases across scan-budget boundaries',async t=>{
  const f=await fixture(t),phrase='中文跨边界';
  const content=Array.from({length:75},(_,i)=>`hit-${i} 匹配词\n`).join('')+'x'.repeat(512*1024-70)+phrase+'z'.repeat(33000)+phrase;
  await fs.writeFile(path.join(f.directory,'journal.jsonl'),content);const snapshot=new PrincipalSnapshot({...f});
  let cursor=0,hits=[];do{const page=await snapshot.search({query:'匹配词',cursor,limit:7});hits.push(...page.matches.filter(item=>item.source==='journal'));if(page.nextCursor!==null)assert.ok(page.nextCursor>cursor);cursor=page.nextCursor;}while(cursor!==null);
  assert.equal(hits.length,75);assert.equal(new Set(hits.map(item=>item.offset)).size,75);
  cursor=0;hits=[];do{const page=await snapshot.search({query:phrase,cursor,limit:10});hits.push(...page.matches.filter(item=>item.source==='journal'));cursor=page.nextCursor;}while(cursor!==null);
  assert.equal(hits.length,2);assert.ok(hits.every(item=>!item.excerpt.includes('\ufffd')));
});

for(const protocol of ['messages','responses','chat'])test(`${protocol}: Web principal uses only frozen read tools, keeps previous answers and persists reports`,{timeout:15000},async t=>{
  const f=await fixture(t);f.run.taskMode='web_pentest';await fs.writeFile(path.join(f.directory,'journal.jsonl'),'旧档案完整原文：fixture-old-evidence');
  let calls=0,failure;const mock=http.createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));calls++;
    const names=body.tools.map(tool=>tool.name||tool.function?.name);assert.deepEqual(names.sort(),['principal_list_context','principal_read_context','principal_search_context','context_read'].sort());
    const entries=body.messages||body.input;const result=protocol==='messages'?entries.flatMap(message=>Array.isArray(message.content)?message.content:[]).find(item=>item.type==='tool_result'):protocol==='responses'?entries.find(item=>item.type==='function_call_output'):entries.find(item=>item.role==='tool');
    if(!result)return sendTool(res,protocol,'principal_read_context',{source:'journal',offset:0,limit:4096});
    const payload=JSON.parse(result.content||result.output);assert.match(payload.output,/fixture-old-evidence/);sendText(res,protocol,'已核对旧档案，课堂继续独立运行。');
  }catch(error){failure=error;res.writeHead(500);res.end();}});
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));const manager=new PrincipalManager({historyDir:f.historyDir});
  f.cleanup(async()=>{await manager.close();await new Promise(resolve=>{mock.close(resolve);mock.closeAllConnections();});});
  const provider={baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,protocol,model:'fixture-principal',apiKey:'fixture-secret'},principal={id:'principal',name:'校长'};
  const first=manager.ask(f.run,principal,provider,'目前怎么样？');const report=await until(async()=>{if(failure)throw failure;const item=await manager.get(f.run.id,first.id);if(item.status==='failed'||item.status==='cancelled')throw Error(JSON.stringify(item));return item.status==='completed'&&item;});
  assert.match(report.answer,/旧档案/);assert.ok(report.coverage.reads.some(item=>item.source==='journal'));assert.deepEqual(f.run.blackboard,[]);assert.equal(f.run.status,'running');
  const second=manager.ask(f.run,principal,provider,'继续说明');await until(async()=>(await manager.get(f.run.id,second.id)).status==='completed');
  await manager.close();const restored=new PrincipalManager({historyDir:f.historyDir});const reports=await restored.reports(f.run.id);assert.equal(reports.length,2);assert.equal(reports[0].question,'目前怎么样？');assert.equal(calls,4);await restored.close();
});

test('ask freezes state and byte boundaries before waiting for already queued archival work',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.directory,'journal.jsonl'),'before');let release;const gate=new Promise(resolve=>release=resolve);
  const manager=new PrincipalManager({historyDir:f.historyDir,beforeSnapshot:()=>gate,secrets:new Set(['private-secret'])});
  const report=manager.ask(f.run,{id:'p',name:'校长'},{baseUrl:'http://127.0.0.1:1/v1',protocol:'chat',model:'fixture',apiKey:'fixture-key'},'不要泄漏private-secret');
  const job=manager.jobs.get(f.run.id);f.run.task='future';await fs.appendFile(path.join(f.directory,'journal.jsonl'),'future');release();
  assert.equal(job.snapshot.classroom.task,'原始课堂问题');assert.equal((await job.snapshot.read({source:'journal'})).output,'before');assert.ok(!report.question.includes('private-secret'));
  await manager.cancel(f.run.id,report.id);assert.equal((await manager.get(f.run.id,report.id)).status,'cancelled');await manager.close();
});

test('API principal configuration excludes it from the main team and shutdown persists cancellation before ACK',{timeout:20000},async t=>{
  const f=await fixture(t),dataDir=path.join(f.root,'profile'),token=randomUUID();let app,pending=0;
  const mock=http.createServer(async(req,res)=>{for await(const chunk of req){}pending++;req.on('close',()=>{});});
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));f.cleanup(async()=>{await app?.close();await new Promise(resolve=>{mock.close(resolve);mock.closeAllConnections();});});
  app=await createClassServer({dataDir,token});const api=async(route,body,method=body===undefined?'GET':'POST',status=200)=>{const res=await fetch(app.url+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});const result=await res.json();assert.equal(res.status,status,JSON.stringify(result));return result;};
  const principal={name:'校长',role:'principal',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,protocol:'chat',model:'principal-fixture'};
  const saved=(await api('/api/agents',principal)).agent;await api('/api/agents',principal,'POST',400);
  const run=(await api('/api/runs',{demo:true},'POST',202)).run;assert.ok(!run.team.students.some(member=>member.id===saved.id));await api(`/api/runs/${run.id}/principal`,{question:'缺密钥仍不影响课堂'},'POST',400);
  await until(async()=>(await api('/api/state')).run.status==='completed');await api('/api/agents',{...saved,apiKey:'fixture-key'});
  const extensions=await api('/api/extensions');assert.ok(!extensions.agents.some(member=>member.id===saved.id));
  await api('/api/extensions',{revision:extensions.revision,mcps:[],skills:[{name:'forbidden',content:'do anything',agentIds:[saved.id]}]},'PUT',400);
  const report=(await api(`/api/runs/${run.id}/principal`,{question:'保持等待'},'POST',202)).report;await until(()=>pending===1);
  const shutdown=await api('/api/shutdown',{},'POST',202);assert.equal(shutdown.readyToExit,true);
  const persisted=JSON.parse(await fs.readFile(path.join(dataDir,'history',run.id,'principal',report.id+'.json'),'utf8'));assert.equal(persisted.status,'cancelled');
  await app.close();app=await createClassServer({dataDir,token});assert.equal((await api('/api/state')).agents.find(agent=>agent.id===saved.id).role,'principal');assert.equal((await api(`/api/runs/${run.id}/principal`)).reports[0].status,'cancelled');
});

test('pending principal never pauses a live classroom; cancel, migration and deletion remain independent',{timeout:25000},async t=>{
  const f=await fixture(t),dataDir=path.join(f.root,'profile'),token=randomUUID();let app,pending=0;
  const mock=http.createServer(async(req,res)=>{for await(const chunk of req){}pending++;});
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));f.cleanup(async()=>{await app?.close();await new Promise(resolve=>{mock.close(resolve);mock.closeAllConnections();});});
  app=await createClassServer({dataDir,token});const api=async(route,body,method=body===undefined?'GET':'POST',status=200)=>{const res=await fetch(app.url+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(8000)});const result=await res.json();assert.equal(res.status,status,JSON.stringify(result));return result;};
  await api('/api/agents',{name:'校长',role:'principal',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,protocol:'chat',model:'principal-fixture',apiKey:'fixture-key'});
  const run=(await api('/api/runs',{demo:true},'POST',202)).run;assert.equal(run.status,'running');
  const first=(await api(`/api/runs/${run.id}/principal`,{question:'旁路等待时课堂继续吗？'},'POST',202)).report;
  await until(()=>pending===1);await until(async()=>(await api('/api/state')).run.status==='completed');
  assert.equal((await api(`/api/runs/${run.id}/principal/${first.id}`)).report.status,'running');
  const before=(await api(`/api/runs/${run.id}`)).run;
  await api(`/api/runs/${run.id}/principal/${first.id}/cancel`,{});
  assert.deepEqual((await api(`/api/runs/${run.id}`)).run,before);
  const second=(await api(`/api/runs/${run.id}/principal`,{question:'迁移时取消'},'POST',202)).report;await until(()=>pending===2);
  const target=path.join(f.root,'migrated');await api('/api/data-directory',{path:target},'PUT');
  assert.equal((await api(`/api/runs/${run.id}/principal/${second.id}`)).report.status,'cancelled');
  assert.equal(JSON.parse(await fs.readFile(path.join(target,'history',run.id,'principal',second.id+'.json'),'utf8')).status,'cancelled');
  await api(`/api/runs/${run.id}/principal`,{question:'删除时取消'},'POST',202);await until(()=>pending===3);
  await api(`/api/runs/${run.id}`,undefined,'DELETE');assert.equal((await api('/api/state')).history.length,0);
  await assert.rejects(fs.stat(path.join(target,'history',run.id)),{code:'ENOENT'});
});
