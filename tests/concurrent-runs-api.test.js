import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClassServer } from '../src/web-server.js';
import { createProfileStore } from '../src/profile-store.js';

const nativeBinary=process.env.CLASS_TEST_NATIVE_BINARY;

async function nativeApplication({directory,root}) {
  assert.ok(path.isAbsolute(nativeBinary),'CLASS_TEST_NATIVE_BINARY must be an absolute executable path');
  const executable=await fs.realpath(nativeBinary),home=path.join(root,'native-home');
  const isolated={HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),TEMP:path.join(home,'tmp'),TMP:path.join(home,'tmp'),TMPDIR:path.join(home,'tmp'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local','share'),XDG_STATE_HOME:path.join(home,'.local','state'),XDG_CACHE_HOME:path.join(home,'.cache')};
  await Promise.all(Object.values(isolated).map(value=>fs.mkdir(value,{recursive:true})));
  // Inherit only OS essentials; never copy the user's Class/provider/proxy
  // credentials or real profile locations into the native test process.
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|LANG|LC_ALL|LC_CTYPE)$/i.test(key)));
  Object.assign(env,isolated);
  const child=spawn(executable,['--data-dir',directory,'--no-browser'],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let exit,spawnError,instance,closed=false,forced=false;
  const exited=new Promise(resolve=>{child.once('error',error=>{spawnError=error;resolve();});child.once('exit',(code,signal)=>{exit={code,signal};resolve();});});
  // Native Linux writes an entry path; consume both pipes without exposing a
  // possible browser URL/session token in test output.
  child.stdout.resume();child.stderr.resume();
  const stop=async()=>{
    if(closed)return;closed=true;
    if(!exit&&!spawnError&&instance){
      await fetch(instance.url.replace(/\/$/,'')+'/api/shutdown',{method:'POST',headers:{authorization:'Bearer '+instance.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(20000)}).catch(()=>{});
    }
    if(!exit&&!spawnError){
      await Promise.race([exited,delay(20000,undefined,{ref:false})]);
      if(!exit&&!spawnError){forced=true;child.kill();await Promise.race([exited,delay(5000,undefined,{ref:false})]);}
    }
    assert.ok(exit||spawnError,'the owned native child must exit before removing its fixture');
    if(instance){assert.equal(forced,false,'native shutdown must finish without forced termination');assert.equal(exit?.code,0,'native shutdown must exit successfully');}
  };
  try{
    const deadline=Date.now()+30000;
    while(true){
      if(spawnError)throw new Error('Could not launch the owned native executable: '+spawnError.code);
      if(exit)throw new Error('Owned native executable exited before startup: '+JSON.stringify(exit));
      try{const candidate=JSON.parse(await fs.readFile(path.join(directory,'instance.json'),'utf8'));if(candidate.pid===child.pid){
        const url=new URL(candidate.url);
        assert.equal(url.protocol,'http:');assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.ok(url.port);assert.match(candidate.token,/^[a-f0-9]{64}$/);assert.ok(candidate.instanceId);
        instance=candidate;break;
      }}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
      if(Date.now()>deadline)throw new Error('Owned native executable did not publish its matching instance PID');
      await delay(40);
    }
    return {url:instance.url.replace(/\/$/,''),token:instance.token,close:stop};
  }catch(error){await stop();throw error;}
}

// All providers are a loopback fixture. The only tool action is a text write or
// read inside the owned per-run workspace; no external MCP or model is called.
async function fixture(t) {
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'class-concurrent-api-'));
  const source=path.join(root,'source'),target=path.join(root,'target'),secret='isolated-concurrent-key-'+randomUUID();let token=randomUUID();
  const requests=[],held=[],responses=new Map();let app,dataDir=source,failure;
  const tool=(res,name,input)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({stop_reason:'tool_use',content:[{type:'tool_use',id:randomUUID(),name,input}]}));};
  const mock=http.createServer(async(req,res)=>{
    try {
      const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts));
      const input=JSON.parse(body.messages.find(message=>message.role==='user'&&typeof message.content==='string').content);
      const name=input.task?.match(/^任务名称：([^\n]+)/)?.[1];assert.ok(name,'taskSpec reaches the actual provider request');
      const results=body.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(block=>block.type==='tool_result');
      const request={name,model:body.model,input,body,key:req.headers['x-api-key'],results};requests.push(request);
      if(body.tools?.some(tool=>tool.name==='define_acceptance'))return tool(res,'define_acceptance',{criteria:[{id:'file',description:'Write this task name to shared.txt and verify it.',evidenceType:'tool'}]});
      if(body.model.startsWith('alice')&&!results.length)return tool(res,'write_file',{path:'shared.txt',content:name});
      if(body.model.startsWith('alice')&&results.length){responses.set(name,JSON.parse(results.at(-1).content));}
      held.push({name,model:body.model,res,request});
      // Keep each student's next decision pending until the test explicitly
      // releases it or this particular run's AbortSignal closes the request.
    }catch(error){failure=error;if(!res.headersSent)res.writeHead(500);res.end();}
  });
  const f={root,source,target,secret,requests,held,responses,get token(){return token;},get app(){return app;},get dataDir(){return dataDir;},
    spec:name=>({name,description:'Read the owned fixture and independently write the requested task name.',goal:'Save and verify the exact task name in shared.txt.'}),
    async start(directory=dataDir){dataDir=directory;app=nativeBinary?await nativeApplication({directory,root}):await createClassServer({dataDir,dataAnchor:source,token});if(nativeBinary)token=app.token;await f.api('/api/memory/settings',{enabled:false},'PUT');},
    async close(){if(app){const old=app;app=null;await old.close();}},
    async api(route,body,method=body===undefined?'GET':'POST',status=200){
      if(failure)throw failure;
      const response=await fetch(app.url+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
      const value=await response.json();assert.ok((Array.isArray(status)?status:[status]).includes(response.status),`${method} ${route}: ${response.status} ${JSON.stringify(value)}`);
      assert.ok(!JSON.stringify(value).includes(secret),'API response cannot include provider credentials');return value;
    },
    async until(check,diagnostic){const deadline=Date.now()+15000;while(true){if(failure)throw failure;const value=await check();if(value)return value;if(Date.now()>deadline)throw Error('Concurrent API fixture timed out'+(diagnostic?': '+JSON.stringify(await diagnostic()):''));await delay(30);}},
    release(name,toolName='read_file',input={path:'shared.txt'}){
      const pending=held.find(entry=>entry.name===name&&entry.model.startsWith('alice')&&!entry.res.destroyed&&!entry.res.writableEnded);assert.ok(pending,'an isolated pending student response exists');tool(pending.res,toolName,input);
    },
    async run(id){return (await f.api('/api/runs/'+id)).run;},
    async written(name,id){await f.until(()=>responses.get(name)?.evidenceRef,async()=>{const run=await f.run(id);return {id,status:run.status,error:run.error,memberFailures:run.memberFailures,lastEvents:run.events?.slice(-5),requests:requests.filter(item=>item.name===name).map(item=>({model:item.model,resultCount:item.results.length})),toolResult:responses.get(name)};});return f.run(id);},
  };
  t.after(async()=>{
    await f.close();await new Promise(resolve=>{mock.close(resolve);mock.closeAllConnections();});
    const resolved=await fs.realpath(root);assert.equal(path.dirname(resolved),parent);assert.equal((await fs.lstat(root)).isSymbolicLink(),false);await fs.rm(resolved,{recursive:true,force:true});
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const store=await createProfileStore(source),ids=['teacher','alice','bob'];
  await store.save({...store.config,agents:ids.map(id=>({id,name:id,role:id==='teacher'?'teacher':'student',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,protocol:'messages',model:id}))},Object.fromEntries(ids.map(id=>[id,secret])));
  await f.start();return f;
}

test('concurrent runs isolate workspaces, context and evidence; pause/stop/configuration affect only their own task', {timeout:75000}, async t=>{
  const f=await fixture(t),aName='fixture-A-'+randomUUID(),bName='fixture-B-'+randomUUID(),cName='fixture-C-'+randomUUID();
  const a=(await f.api('/api/runs',{taskSpec:f.spec(aName),taskMode:'auto'},'POST',202)).run;
  const b=(await f.api('/api/runs',{taskSpec:f.spec(bName),taskMode:'auto'},'POST',202)).run;
  const [aLive,bLive]=await Promise.all([f.written(aName,a.id),f.written(bName,b.id)]);
  assert.notEqual(aLive.cwd,bLive.cwd);assert.ok(aLive.cwd.includes(a.id));assert.ok(bLive.cwd.includes(b.id));
  assert.equal(await fs.readFile(path.join(aLive.cwd,'shared.txt'),'utf8'),aName);assert.equal(await fs.readFile(path.join(bLive.cwd,'shared.txt'),'utf8'),bName);
  let state=await f.api('/api/state');assert.deepEqual(new Set(state.runs.map(run=>run.id)),new Set([a.id,b.id]));
  for(const [name,other,id]of[[aName,bName,a.id],[bName,aName,b.id]]){
    const observed=f.requests.filter(request=>request.name===name);assert.ok(observed.length>=3);assert.ok(observed.every(request=>!JSON.stringify(request.body).includes(other)));
    const evidence=await f.api(`/api/runs/${id}/evidence?limit=200`);assert.ok(JSON.stringify(evidence).includes(name));assert.ok(!JSON.stringify(evidence).includes(other));
    assert.match(f.responses.get(name).evidenceRef,new RegExp(id));
  }
  await f.api(`/api/runs/${a.id}/pause`,{},'POST');assert.equal((await f.run(a.id)).status,'paused');assert.equal((await f.run(b.id)).status,'running');
  const beforeA=f.requests.filter(request=>request.name===aName).length;
  f.release(aName);f.release(bName);
  await f.until(()=>f.requests.filter(request=>request.name===bName&&request.model==='alice').some(request=>request.results.length>=2));await delay(100);
  assert.equal(f.requests.filter(request=>request.name===aName).length,beforeA,'paused task cannot advance its model/tool loop');
  await f.api(`/api/runs/${a.id}/resume`,{},'POST',202);await f.until(()=>f.requests.filter(request=>request.name===aName&&request.model==='alice').some(request=>request.results.length>=2));
  state=await f.api('/api/state');const alice=state.agents.find(agent=>agent.id==='alice'),newSecret='isolated-updated-key-'+randomUUID();
  await f.api('/api/agents',{...alice,model:'alice-updated',apiKey:newSecret},'POST');
  const c=(await f.api('/api/runs',{taskSpec:f.spec(cName)},'POST',202)).run;await f.written(cName,c.id);
  assert.ok(f.requests.some(request=>request.name===cName&&request.model==='alice-updated'&&request.key===newSecret));
  f.release(bName);await f.until(()=>f.requests.filter(request=>request.name===bName&&request.model==='alice').some(request=>request.results.length>=3));
  assert.ok(f.requests.filter(request=>request.name===bName&&request.model.startsWith('alice')).every(request=>request.model==='alice'&&request.key===f.secret));
  await f.api(`/api/runs/${a.id}/stop`,{},'POST');await f.until(async()=>['stopped','failed'].includes((await f.run(a.id)).status));
  assert.equal((await f.run(b.id)).status,'running');assert.equal((await f.run(c.id)).status,'running');
  state=await f.api('/api/state');assert.ok(!JSON.stringify(state).includes(newSecret));assert.equal(state.runs.some(run=>run.id===a.id),false);
  await f.api('/api/runs/'+a.id,undefined,'DELETE');
  state=await f.api('/api/state');assert.equal(state.history.some(run=>run.id===a.id),false);assert.deepEqual(new Set(state.runs.map(run=>run.id)),new Set([b.id,c.id]),'deleting A cannot stop B or C');
  await f.api('/api/shutdown',{},'POST',202);await f.close();
  for(const id of[b.id,c.id]){const saved=JSON.parse(await fs.readFile(path.join(f.source,'history',id+'.json'),'utf8'));assert.equal(saved.status,'stopped');}
});

test('scheduled work starts alongside an active run while editing, cancellation and repeated manual starts remain isolated', {timeout:75000}, async t=>{
  const f=await fixture(t),bName='active-B-'+randomUUID(),cName='scheduled-C-'+randomUUID(),dName='cancelled-D-'+randomUUID(),eName='manual-E-'+randomUUID();
  const b=(await f.api('/api/runs',{taskSpec:f.spec(bName)},'POST',202)).run;await f.written(bName,b.id);
  const at=new Date(Date.now()+2300).toISOString(),schedule={at,timeZone:'Asia/Shanghai'};
  const c=(await f.api('/api/runs',{taskSpec:f.spec(cName),schedule},'POST',202)).run;
  const d=(await f.api('/api/runs',{taskSpec:f.spec(dName),schedule},'POST',202)).run;
  assert.equal(c.status,'scheduled');assert.equal(d.status,'scheduled');assert.equal((await f.run(c.id)).taskSpec.name,cName);
  const renamed=cName+'-renamed',revised={...f.spec(renamed),description:'Updated pending instructions with an exact marker.'};
  await f.api('/api/runs/'+c.id,{taskSpec:revised},'PATCH');await f.api(`/api/runs/${d.id}/cancel`,{},'POST',202);
  assert.equal((await f.run(c.id)).title,renamed,'pending task edits update the history name');
  // Two rejected directory transitions must not close/reopen the scheduler or
  // turn C into a missed task while B is running.
  await Promise.all([f.api('/api/data-directory',{path:f.target},'PUT',409),f.api('/api/data-directory',{path:path.join(f.root,'other-target')},'PUT',409)]);
  assert.equal((await f.api('/api/state')).dataDir,f.source);
  const e=(await f.api('/api/runs',{taskSpec:f.spec(eName),schedule:{at:new Date(Date.now()+60000).toISOString(),timeZone:'UTC'}},'POST',202)).run;
  await f.api(`/api/runs/${e.id}/start`,{},'POST',202);await f.written(eName,e.id);
  await f.api(`/api/runs/${e.id}/start`,{},'POST',[400,404,405,409]);
  await f.written(renamed,c.id);
  assert.equal(f.requests.some(request=>request.name===cName),false,'the earlier pending title never reaches a model');
  assert.ok(f.requests.filter(request=>request.name===renamed).every(request=>request.input.task.includes(revised.description)));
  assert.equal((await f.run(b.id)).status,'running');assert.equal((await f.run(d.id)).status,'cancelled');assert.equal(f.requests.some(request=>request.name===dName),false);
  const state=await f.api('/api/state');assert.deepEqual(new Set(state.runs.map(run=>run.id)),new Set([b.id,c.id,e.id]));
  assert.equal(f.requests.filter(request=>request.name===eName&&request.body.tools?.some(tool=>tool.name==='define_acceptance')).length,1,'manual start creates exactly one run');
  const stored=await fs.readFile(path.join(f.source,'task-schedules.json'),'utf8');assert.ok(!stored.includes(f.secret));assert.doesNotMatch(stored,/"(?:apiKey|authorization|token|secret)"\s*:/i);
  await f.api('/api/runs/'+d.id,undefined,'DELETE');assert.equal((await f.api('/api/state')).history.some(run=>run.id===d.id),false);
});

test('restart marks overdue schedules missed; migration preserves future schedules and uploaded files until explicit start', {timeout:75000}, async t=>{
  const f=await fixture(t),missedName='missed-'+randomUUID(),futureName='migrated-'+randomUUID();
  const missedAt=Date.now()+1800,missed=(await f.api('/api/runs',{taskSpec:f.spec(missedName),schedule:{at:new Date(missedAt).toISOString(),timeZone:'Asia/Shanghai'}},'POST',202)).run;
  await f.close();await delay(Math.max(0,missedAt-Date.now()+70));await f.start();
  assert.equal((await f.run(missed.id)).status,'missed');assert.equal(f.requests.some(request=>request.name===missedName),false);
  const attachment=(await f.api('/api/attachments',{name:'planned-input.txt',contentBase64:Buffer.from('owned migration attachment').toString('base64')},'POST',201)).attachment;
  const future=(await f.api('/api/runs',{taskSpec:f.spec(futureName),attachmentIds:[attachment.id],schedule:{at:new Date(Date.now()+60000).toISOString(),timeZone:'UTC'}},'POST',202)).run;
  assert.equal(future.attachments[0].id,attachment.id);
  const moved=await f.api('/api/data-directory',{path:f.target},'PUT');assert.equal(moved.dataDir,f.target);
  assert.equal((await f.run(future.id)).status,'scheduled');assert.equal(f.requests.some(request=>request.name===futureName),false);
  const scheduleFile=JSON.parse(await fs.readFile(path.join(f.target,'task-schedules.json'),'utf8'));
  const stored=scheduleFile.items.find(item=>item.id===future.id);assert.deepEqual(stored.payload.attachmentIds,[attachment.id]);assert.equal(stored.runId,future.id);
  assert.equal(await fs.readFile(path.join(f.target,'attachments',attachment.id,'content'),'utf8'),'owned migration attachment');
  await f.close();await f.start(f.target);assert.equal((await f.run(future.id)).status,'scheduled');assert.equal((await f.run(missed.id)).status,'missed');
  await f.api(`/api/runs/${future.id}/start`,{},'POST',202);const active=await f.written(futureName,future.id);
  assert.ok(active.cwd.startsWith(path.join(f.target,'workspace')+path.sep));assert.ok(!active.cwd.startsWith(path.join(f.source,'workspace')+path.sep));
  assert.equal(await fs.readFile(path.join(active.cwd,active.attachments[0].path),'utf8'),'owned migration attachment');
  assert.equal(await fs.readFile(path.join(active.cwd,'shared.txt'),'utf8'),futureName);
  assert.ok(f.requests.filter(request=>request.name===futureName).every(request=>request.input.attachments?.[0]?.id===attachment.id));
  await f.api(`/api/runs/${missed.id}/start`,{},'POST',202);await f.written(missedName,missed.id);
  assert.equal(f.requests.filter(request=>request.name===missedName&&request.body.tools?.some(tool=>tool.name==='define_acceptance')).length,1);
});
