import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createClassServer } from '../src/web-server.js';
import { createProfileStore } from '../src/profile-store.js';
import { prepareExtensionUpdate } from '../src/extension-config.js';

const initialized = { protocolVersion:'2025-06-18', capabilities:{ tools:{} }, serverInfo:{ name:'owned connection fixture', version:'1' } };
const tool = { name:'fixture_echo', description:'Never called by a connection test', inputSchema:{ type:'object', properties:{} } };
const entry = (id, config) => ({ id, name:id, enabled:false, agentIds:[], ...config });
const reply = (res, id, result) => { res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify({ jsonrpc:'2.0', id, result })); };
async function readBody(req) { const chunks=[]; for await(const chunk of req)chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); }
async function eventually(predicate, message, attempts=250) {
  for(let i=0;i<attempts;i++){if(await predicate())return;await delay(20);}
  assert.ok(await predicate(),message);
}
async function lines(filename) { try{return (await fs.readFile(filename,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;} }
function alive(pid) { try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;} }

async function localServer(t, handler) {
  const failures=[], streams=new Set();
  const server=createServer((req,res)=>{
    Promise.resolve(handler(req,res)).catch(error=>{failures.push(error);res.destroy();});
    res.once('close',()=>streams.delete(res));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.deepEqual(failures,[]);});
  return {url:'http://127.0.0.1:'+server.address().port,streams};
}

async function harness(t, makeEntries, {timeout=10000, beforeStart}={}) {
  const parent=await fs.realpath(os.tmpdir()), root=await fs.mkdtemp(path.join(parent,'class-mcp-connection-api-'));
  const dataDir=path.join(root,'data'),token=randomUUID();let app;
  t.after(async()=>{
    await app?.close();
    const actual=await fs.realpath(root);assert.equal(path.dirname(actual),parent);assert.ok(path.basename(actual).startsWith('class-mcp-connection-api-'));
    assert.equal((await fs.lstat(root)).isSymbolicLink(),false);await fs.rm(actual,{recursive:true,force:true});
  });
  const store=await createProfileStore(dataDir),mcps=await makeEntries(root);
  const update=prepareExtensionUpdate({revision:store.config.extensions.revision,mcps,skills:[]},store.config.extensions,[],store.secrets);
  await store.save({...store.config,extensions:update.extensions},update.secrets);
  await beforeStart?.(store);
  app=await createClassServer({dataDir,token,mcpTestTimeoutMs:timeout});
  const api=async(route,body,{status=200,method=body===undefined?'GET':'POST'}={})=>{
    const response=await fetch(app.url+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
  };
  const extensions=await api('/api/extensions');
  const probe=(id,options)=>api('/api/extensions/test',{id,revision:extensions.revision},options);
  return {root,dataDir,token,app,api,probe,extensions};
}

async function persistentState(host) {
  const files={};
  for(const name of (await fs.readdir(host.dataDir)).filter(name=>name==='profiles.json'||name.startsWith('credentials.')).sort())files[name]=(await fs.readFile(path.join(host.dataDir,name))).toString('base64');
  return {files,extensions:await host.api('/api/extensions'),history:(await host.api('/api/state')).history,historyFiles:await fs.readdir(path.join(host.dataDir,'history'))};
}
function success(value,count) {assert.equal(value.ok,true,JSON.stringify(value));assert.equal(value.toolCount,count);assert.ok(Number.isFinite(value.durationMs)&&value.durationMs>=0);}
function failure(value,code) {assert.equal(value.ok,false,JSON.stringify(value));assert.equal(typeof value.message,'string');assert.ok(value.message.length>0);if(code)assert.equal(value.code,code);assert.ok(Number.isFinite(value.durationMs)&&value.durationMs>=0);}

function stdioEntry(id, root, {hang=false,secret='fixture-env-not-a-real-key'}={}) {
  const log=path.join(root,id+'.jsonl');
  const script=`const fs=require('node:fs');const log=x=>fs.appendFileSync(process.env.MCP_FIXTURE_LOG,JSON.stringify(x)+'\\n');log({event:'started',pid:process.pid,authenticated:process.env.FIXTURE_SECRET===${JSON.stringify(secret)}});let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);log({method:m.method});if(m.id&&(!${hang}||m.method==='initialize'))process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?${JSON.stringify(initialized)}:{tools:[${JSON.stringify(tool)}]}})+'\\n');}});process.stdin.on('end',()=>process.exit(0));process.stdout.on('error',()=>process.exit(0));`;
  return {log,config:entry(id,{transport:'stdio',command:process.execPath,args:['-e',script],env:{MCP_FIXTURE_LOG:log,FIXTURE_SECRET:secret}})};
}

test('saved disabled and ungranted stdio, HTTP and SSE MCPs can be tested without calling tools or persisting changes', {timeout:45000}, async t=>{
  const calls=[],legacyStreams=new Set();let legacy;
  const remote=await localServer(t,async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer local-api-fixture');
    if(req.method==='GET'){legacy=res;legacyStreams.add(res);res.once('close',()=>legacyStreams.delete(res));res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: endpoint\ndata: /messages\n\n');return;}
    const message=await readBody(req);calls.push({path:req.url,method:message.method});
    if(req.url==='/messages'){
      res.writeHead(202).end();
      if(message.id)legacy.write('data: '+JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'?initialized:{tools:[tool, {...tool,name:'second'}]}})+'\n\n');
      return;
    }
    if(message.method!=='initialize')assert.equal(req.headers['mcp-session-id'],'connection-fixture');
    if(!message.id){res.writeHead(202).end();return;}
    if(message.method==='initialize')res.setHeader('Mcp-Session-Id','connection-fixture');
    reply(res,message.id,message.method==='initialize'?initialized:{tools:[]});
  });
  let stdio;
  const host=await harness(t,root=>{
    stdio=stdioEntry('stdio-fixture',root);
    return [stdio.config,entry('http-fixture',{transport:'http',url:remote.url+'/mcp',headers:{Authorization:'Bearer local-api-fixture'}}),entry('sse-fixture',{transport:'sse',url:remote.url+'/sse',headers:{Authorization:'Bearer local-api-fixture'}})];
  });
  const before=await persistentState(host);
  success(await host.probe('stdio-fixture'),1);
  success(await host.probe('http-fixture'),0);
  success(await host.probe('sse-fixture'),2);
  assert.deepEqual(await persistentState(host),before);
  const records=await lines(stdio.log);assert.equal(records[0].authenticated,true);
  assert.deepEqual(records.filter(item=>item.method).map(item=>item.method),['initialize','notifications/initialized','tools/list']);
  await eventually(()=>!alive(records[0].pid),'stdio test process must exit before probe completion');
  assert.deepEqual(calls.filter(item=>item.path==='/mcp').map(item=>item.method),['initialize','notifications/initialized','tools/list']);
  assert.deepEqual(calls.filter(item=>item.path==='/messages').map(item=>item.method),['initialize','notifications/initialized','tools/list']);
  await eventually(()=>legacyStreams.size===0,'legacy SSE test stream must be closed');
});

test('connection test validates authentication, saved IDs, revision and request shape before contacting MCP', async t=>{
  let requests=0;
  const remote=await localServer(t,async(req,res)=>{requests++;await readBody(req);res.writeHead(500).end();});
  const host=await harness(t,()=>[entry('saved',{transport:'http',url:remote.url})]);
  const revision=host.extensions.revision,before=await persistentState(host);
  for(const body of [{},null,[],{id:'saved'},{id:'saved',revision:'1'},{id:'saved',revision:-1},{id:1,revision},{id:'saved',revision,url:remote.url},{id:'saved',revision,timeoutMs:1}])await host.api('/api/extensions/test',body,{status:400});
  await host.api('/api/extensions/test',{id:'missing',revision},{status:404});
  await host.api('/api/extensions/test',{id:'saved',revision:revision-1},{status:409});
  const unauthorized=await fetch(host.app.url+'/api/extensions/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'saved',revision})});
  assert.equal(unauthorized.status,401);await unauthorized.arrayBuffer();
  assert.equal(requests,0);assert.deepEqual(await persistentState(host),before);
});

test('connection errors and total timeout return bounded diagnostics without leaking saved credentials or creating history', async t=>{
  const secret='private-fixture-value-connection-123',calls=[],streams=new Set();
  const remote=await localServer(t,async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+secret);const message=await readBody(req);calls.push(message.method);
    if(!message.id){res.writeHead(202).end();return;}
    if(req.url==='/failure'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'private remote error '+secret}}));return;}
    if(message.method==='initialize'){reply(res,message.id,initialized);return;}
    streams.add(res);res.once('close',()=>streams.delete(res));res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': wait\n\n');
  });
  const host=await harness(t,()=>['failure','timeout'].map(id=>entry(id,{transport:'http',url:remote.url+'/'+id,headers:{Authorization:'Bearer '+secret}})),{timeout:200});
  const before=await persistentState(host),failed=await host.probe('failure');failure(failed);
  assert.ok(!JSON.stringify(failed).includes(secret));assert.ok(!JSON.stringify(failed).includes('private remote error'));
  const started=Date.now(),timedOut=await host.probe('timeout');failure(timedOut,'MCP_TIMEOUT');assert.ok(Date.now()-started<5000);
  assert.ok(!JSON.stringify(timedOut).includes(secret));assert.ok(!calls.includes('tools/call'));
  await eventually(()=>streams.size===0,'timeout must close the in-flight SSE response');
  assert.deepEqual(await persistentState(host),before);
});

test('testing a disabled MCP still rejects credentials bound to a different saved endpoint', async t=>{
  let requests=0;
  const remote=await localServer(t,async(req,res)=>{requests++;await readBody(req);res.writeHead(500).end();});
  const host=await harness(t,()=>[entry('bound',{transport:'http',url:remote.url+'/original',headers:{Authorization:'Bearer bound-fixture-secret'}})],{
    beforeStart:async store=>{await store.save({...store.config,extensions:{...store.config.extensions,mcps:store.config.extensions.mcps.map(item=>item.id==='bound'?{...item,url:remote.url+'/changed'}:item)}});},
  });
  const before=await persistentState(host);
  await host.probe('bound',{status:409});assert.equal(requests,0);assert.deepEqual(await persistentState(host),before);
});

test('connection test has one total deadline across MCP pagination', async t=>{
  let lists=0;const calls=[];
  const remote=await localServer(t,async(req,res)=>{
    const message=await readBody(req);calls.push(message.method);
    if(!message.id){res.writeHead(202).end();return;}
    if(message.method==='initialize'){reply(res,message.id,initialized);return;}
    lists++;await delay(55);if(!res.destroyed)reply(res,message.id,{tools:[],nextCursor:'page-'+lists});
  });
  const host=await harness(t,()=>[entry('paged',{transport:'http',url:remote.url})],{timeout:180});
  const started=Date.now();failure(await host.probe('paged'),'MCP_TIMEOUT');
  assert.ok(Date.now()-started<3000);assert.ok(lists>=1&&lists<12);assert.ok(!calls.includes('tools/call'));
});

test('a pending test rejects another probe, permits explicit settings edits and cleans up on disconnect', {timeout:30000}, async t=>{
  let stdio;const host=await harness(t,root=>{stdio=stdioEntry('disconnect',root,{hang:true});return [stdio.config];});
  const before=await persistentState(host);
  const request=httpRequest(host.app.url+'/api/extensions/test',{method:'POST',headers:{authorization:'Bearer '+host.token,'content-type':'application/json'}});
  request.on('error',()=>{});request.on('response',response=>response.resume());
  request.end(JSON.stringify({id:'disconnect',revision:host.extensions.revision}));
  t.after(()=>request.destroy());
  await eventually(async()=>(await lines(stdio.log)).some(item=>item.method==='tools/list'),'stdio probe must be waiting for its tool list');
  await host.probe('disconnect',{status:409});
  const edited=await host.api('/api/extensions',{...host.extensions,mcps:host.extensions.mcps.map(item=>item.id==='disconnect'?{...item,name:'Edited while testing'}:item)},{method:'PUT'});
  assert.equal(edited.revision,host.extensions.revision+1);assert.equal(edited.mcps.find(item=>item.id==='disconnect').name,'Edited while testing');
  const afterEdit=await persistentState(host);assert.deepEqual(afterEdit.history,before.history);
  const pid=(await lines(stdio.log))[0].pid;assert.equal(alive(pid),true);request.destroy();
  await eventually(()=>!alive(pid),'disconnected request must terminate its own stdio process',500);
  assert.deepEqual(await persistentState(host),afterEdit);
});

test('application shutdown cancels a test and waits for owned stdio cleanup', {timeout:30000}, async t=>{
  let stdio;const host=await harness(t,root=>{stdio=stdioEntry('shutdown',root,{hang:true});return [stdio.config];});
  const before=await persistentState(host);
  const pending=host.probe('shutdown');
  await eventually(async()=>(await lines(stdio.log)).some(item=>item.method==='tools/list'),'stdio probe must reach tools/list');
  const pid=(await lines(stdio.log))[0].pid;assert.equal(alive(pid),true);
  const shutdown=await host.api('/api/shutdown',{}, {status:202});assert.equal(shutdown.ok,true);
  const result=await pending;failure(result,'MCP_CANCELLED');
  await host.app.close();assert.equal(alive(pid),false);
  const files={};for(const name of Object.keys(before.files))files[name]=(await fs.readFile(path.join(host.dataDir,name))).toString('base64');
  assert.deepEqual(files,before.files);assert.deepEqual(await fs.readdir(path.join(host.dataDir,'history')),before.historyFiles);
});
